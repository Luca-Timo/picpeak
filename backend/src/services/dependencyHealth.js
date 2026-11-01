'use strict';

const fsp = require('fs/promises');
const { constants: fsConstants } = require('fs');
const { db } = require('../database/db');
const { getStoragePath } = require('../config/storage');
const { getAppSetting } = require('../utils/appSettings');
const { toMillis } = require('../utils/queueTimestamps');
const logger = require('../utils/logger');
const hostMetrics = require('./hostMetrics');
const { CAPABILITIES, evaluate, isCapability } = require('./capabilities');

/**
 * One view of what PicPeak depends on, with a breaker per dependency.
 *
 * Probes run on a timer and the result is kept in memory, so a guarded request
 * never waits on a dependency and the answer survives the database being down.
 * Each process keeps its own view; replicas probe the same things and agree
 * within a few intervals.
 *
 * A single bad probe changes nothing. TRIP_AFTER bad probes in a row mean
 * degraded, DOWN_AFTER mean down, and RECOVER_AFTER good ones in a row are
 * needed to come back, so a flapping share does not reopen uploads on every
 * success. /health is deliberately not fed from here: Docker restarting the
 * app cannot repair a share or a mail server.
 */
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
const SLOW_PROBE_MS = 2_000;
const TRIP_AFTER = 2;
const DOWN_AFTER = 4;
const RECOVER_AFTER = 8;

const GIB = 1024 ** 3;
const OLDEST_PENDING_WARN_MS = 30 * 60 * 1000;
const MEMORY_DEGRADED_PERCENT = 92;
const MEMORY_DOWN_PERCENT = 97;
const EVENT_LOOP_DEGRADED_MS = 500;

const ENFORCEMENT_KEY = 'degradation_enforcement';
const FORCED_OFF_KEY = 'degradation_forced_off';

function timed(state, startedAt, detail) {
  const slow = Date.now() - startedAt > SLOW_PROBE_MS;
  return { state: slow && state === 'healthy' ? 'degraded' : state, detail: slow ? 'slow' : detail };
}

/**
 * Free space judged against the size of the disk, with a ceiling: 10% of a 2 TB
 * disk is 200 GB, which is no reason to stop uploads.
 */
function diskState(freeBytes, totalBytes) {
  if (freeBytes < Math.min(totalBytes * 0.03, 5 * GIB)) return 'down';
  if (freeBytes < Math.min(totalBytes * 0.1, 20 * GIB)) return 'degraded';
  return 'healthy';
}

const defaultProbes = {
  async database() {
    const startedAt = Date.now();
    await db.raw('SELECT 1');
    return timed('healthy', startedAt);
  },

  async storage() {
    const startedAt = Date.now();
    if ((process.env.STORAGE_BACKEND || 'local').toLowerCase() === 'local') {
      await fsp.access(getStoragePath(), fsConstants.R_OK | fsConstants.W_OK);
    }
    // stat() resolves null for a missing key and throws when the backend
    // cannot answer, so an object that never exists tests the connection.
    await require('./storage').getStorage().stat('.picpeak-health-probe');
    return timed('healthy', startedAt);
  },

  async disk() {
    const stats = await fsp.statfs(getStoragePath());
    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    return { state: diskState(freeBytes, totalBytes), metrics: { freeBytes, totalBytes } };
  },

  async mail() {
    const { getQueueProcessorStatus } = require('./emailProcessor');
    const status = getQueueProcessorStatus();
    if (!status.started) return { state: 'degraded', detail: 'processor not running' };
    // Mail is queued, so a failing server is never worse than degraded.
    return status.lastError ? { state: 'degraded', detail: status.lastError } : { state: 'healthy' };
  },

  async faceSidecar() {
    const faceSettings = require('./faceSettings');
    // Nothing may contact the sidecar unless the feature is on (faceSettings).
    if (!await faceSettings.isFeatureEnabled()) return null;
    const health = await require('./faceClient').checkHealth();
    return health.ok ? { state: 'healthy' } : { state: 'down', detail: health.error };
  },

  async queues() {
    const [row] = await db('photos').where({ processing_status: 'pending' })
      .count('* as pending').min('uploaded_at as oldest');
    const pending = Number(row?.pending || 0);
    const oldest = row?.oldest ? toMillis(row.oldest) : null;
    const waitingMs = oldest ? Math.max(0, Date.now() - oldest) : 0;
    return {
      state: waitingMs > OLDEST_PENDING_WARN_MS ? 'degraded' : 'healthy',
      metrics: { pendingPhotos: pending, oldestPendingMs: waitingMs },
    };
  },

  async load() {
    const sample = hostMetrics.sample();
    let state = 'healthy';
    if (sample.memoryPercent >= MEMORY_DOWN_PERCENT) state = 'down';
    else if (sample.memoryPercent >= MEMORY_DEGRADED_PERCENT
      || sample.eventLoopDelayMs >= EVENT_LOOP_DEGRADED_MS) state = 'degraded';
    return { state, metrics: sample };
  },
};

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class DependencyHealth {
  constructor({ probes = defaultProbes } = {}) {
    this.probes = probes;
    this.dependencies = new Map();
    this.enforcement = 'observe';
    this.forcedOff = [];
    this.timer = null;
    this.running = null;
    this.warned = new Set();
  }

  applyProbe(name, outcome, { reset = false } = {}) {
    const entry = this.dependencies.get(name) || {
      state: 'healthy', since: new Date().toISOString(), bad: 0, good: 0,
    };
    const raw = outcome.state;
    if (raw === 'healthy') {
      entry.bad = 0;
      entry.good += 1;
    } else {
      entry.good = 0;
      entry.bad += 1;
    }

    let next = entry.state;
    if (raw === 'healthy') {
      if (reset || entry.good >= RECOVER_AFTER) next = 'healthy';
    } else if (raw === 'down' && entry.bad >= DOWN_AFTER) {
      next = 'down';
    } else if (entry.bad >= TRIP_AFTER) {
      next = 'degraded';
    }

    if (next !== entry.state) {
      logger[next === 'healthy' ? 'info' : 'warn'](`Dependency ${name}: ${entry.state} -> ${next}`, {
        detail: outcome.detail,
      });
      entry.state = next;
      entry.since = new Date().toISOString();
    }
    entry.lastCheckedAt = new Date().toISOString();
    entry.detail = outcome.detail || null;
    entry.metrics = outcome.metrics || null;
    this.dependencies.set(name, entry);
  }

  async refreshSettings() {
    // A failed read keeps the last answer: losing the database must not
    // silently change what an admin decided.
    try {
      const enforcement = await getAppSetting(ENFORCEMENT_KEY, 'observe');
      const forcedOff = await getAppSetting(FORCED_OFF_KEY, []);
      this.enforcement = enforcement === 'enforce' ? 'enforce' : 'observe';
      this.forcedOff = Array.isArray(forcedOff) ? forcedOff.filter(isCapability) : [];
    } catch (error) {
      logger.warn('Degradation settings not refreshed', { error: error.message });
    }
  }

  async runProbes(options) {
    await Promise.all(Object.entries(this.probes).map(async ([name, probe]) => {
      let outcome;
      try {
        outcome = await withTimeout(probe());
      } catch (error) {
        outcome = { state: 'down', detail: error.message };
      }
      if (outcome) this.applyProbe(name, outcome, options);
      else this.dependencies.delete(name);
    }));
    await this.refreshSettings();
  }

  /** One pass at a time: a slow probe must not pile up on the next tick. */
  tick(options) {
    if (!this.running) {
      this.running = this.runProbes(options).finally(() => { this.running = null; });
    }
    return this.running;
  }

  /** An admin's "check again": a dependency that answers well recovers at once. */
  async recheck() {
    await this.running;
    await this.tick({ reset: true });
    return this.snapshot();
  }

  states() {
    return Object.fromEntries([...this.dependencies].map(([name, entry]) => [name, entry.state]));
  }

  evaluate(name) {
    return evaluate(name, this.states(), this.forcedOff);
  }

  snapshot() {
    return {
      enforcement: this.enforcement,
      forcedOff: [...this.forcedOff],
      dependencies: Object.fromEntries([...this.dependencies].map(([name, entry]) => [name, {
        state: entry.state,
        since: entry.since,
        lastCheckedAt: entry.lastCheckedAt,
        detail: entry.detail,
        metrics: entry.metrics,
      }])),
      capabilities: Object.keys(CAPABILITIES).map((name) => this.evaluate(name)),
    };
  }

  start() {
    if (this.timer) return;
    this.tick().catch((error) => logger.warn('Dependency probe failed', { error: error.message }));
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.warn('Dependency probe failed', { error: error.message }));
    }, PROBE_INTERVAL_MS);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
    hostMetrics.stop();
  }
}

module.exports = new DependencyHealth();
module.exports.DependencyHealth = DependencyHealth;
module.exports.diskState = diskState;
module.exports.ENFORCEMENT_KEY = ENFORCEMENT_KEY;
module.exports.FORCED_OFF_KEY = FORCED_OFF_KEY;
module.exports.TRIP_AFTER = TRIP_AFTER;
module.exports.DOWN_AFTER = DOWN_AFTER;
module.exports.RECOVER_AFTER = RECOVER_AFTER;

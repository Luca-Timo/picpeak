/**
 * The backend half of the in-app updater (docs/self-update.md).
 *
 * The updater (host agent or container, updater/picpeak-updater.sh) does the
 * actual `pull && up -d`. The backend's whole part in it:
 *   - take a database dump first, so a release whose migrations go wrong can be
 *     restored from Settings -> Backup;
 *   - then create update/request/update-requested (existence is the request);
 *   - read update/status/status.json, which only the updater writes and which
 *     this container mounts read-only, and report it.
 *
 * There is no version argument and nothing else to send: whoever controls this
 * process can trigger an update to the published channel tag and nothing more.
 * Every rule (no downgrade, no source build, manual-only releases) is enforced
 * by the updater itself, because this process is the one assumed compromised.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

const CONTRACT_VERSION = 1;
const STATUS_MAX_BYTES = 64 * 1024;
const FIELD_MAX_LENGTH = 2000;

// Mirrors write_status in updater/picpeak-updater.sh. Anything else in the
// file is ignored rather than passed through to the browser.
const STATES = new Set(['idle', 'running', 'succeeded', 'up_to_date', 'refused', 'failed', 'rolled_back']);
const STRING_FIELDS = [
  'updater_version', 'packaging', 'state', 'reason', 'step', 'message',
  'from_version', 'to_version', 'image', 'started_at', 'finished_at', 'updated_at'
];

// Backend-side phases, before the updater takes over.
//   backing_up     the database dump is running
//   backup_failed  the dump failed; no request was filed
//   request_failed the dump succeeded but the request file could not be written
//   requested      the request file exists; the updater's status is authoritative
const ACTIVE_PHASES = new Set(['backing_up']);

class SelfUpdateError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class SelfUpdateService {
  constructor() {
    this.job = null;
  }

  get updateDir() {
    return process.env.PICPEAK_UPDATE_DIR || '/app/update';
  }

  get requestFile() {
    return path.join(this.updateDir, 'request', 'update-requested');
  }

  get statusFile() {
    return path.join(this.updateDir, 'status', 'status.json');
  }

  // Fail closed: only the exact string enables it. An unset or mistyped value
  // keeps the feature off, as the issue agreed.
  isEnabled() {
    return process.env.PICPEAK_SELF_UPDATE === 'true';
  }

  /**
   * The updater's status, or null when there is none (no agent installed, or
   * the mounts are missing). Validated field by field: the file is written by
   * a root process, but it is still input, and only known fields reach the UI.
   */
  async readAgentStatus() {
    let raw;
    try {
      const handle = await fs.promises.open(this.statusFile, 'r');
      try {
        const { size } = await handle.stat();
        if (size > STATUS_MAX_BYTES) {
          logger.warn('Self-update status file is unexpectedly large; ignoring it', { size });
          return null;
        }
        raw = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Could not read the self-update status file', { error: error.message });
      }
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('Self-update status file is not valid JSON; ignoring it');
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const status = { contract: Number.isInteger(parsed.contract) ? parsed.contract : null };
    for (const field of STRING_FIELDS) {
      const value = parsed[field];
      status[field] = typeof value === 'string' ? value.slice(0, FIELD_MAX_LENGTH) : null;
    }
    if (!STATES.has(status.state)) status.state = null;
    return status;
  }

  jobActive() {
    return Boolean(this.job && ACTIVE_PHASES.has(this.job.phase));
  }

  // A request the updater has not picked up yet. lstat, so a dangling link
  // counts as present too: the updater treats any entry there as a request.
  async requestPending() {
    try {
      await fs.promises.lstat(this.requestFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether an update can be requested now, and why not when it cannot. The
   * UI shows the manual instructions for every reason except `busy`.
   */
  async getStatus() {
    const enabled = this.isEnabled();
    const agent = enabled ? await this.readAgentStatus() : null;

    let reason = null;
    if (!enabled) reason = 'disabled';
    else if (!agent) reason = 'no_agent';
    else if (agent.contract !== CONTRACT_VERSION) reason = 'unsupported_contract';
    else if (agent.state === 'running' || this.jobActive() || await this.requestPending()) reason = 'busy';

    return {
      enabled,
      available: reason === null,
      reason,
      contract: CONTRACT_VERSION,
      agent,
      job: this.job ? { ...this.job } : null
    };
  }

  /**
   * Starts the backup-then-request job and returns it immediately; the caller
   * polls getStatus(). Throws SelfUpdateError when an update cannot start.
   */
  async requestUpdate({ admin }) {
    const status = await this.getStatus();
    if (!status.available) {
      throw new SelfUpdateError(
        status.reason,
        {
          disabled: 'In-app updates are not enabled on this installation.',
          no_agent: 'The updater is not installed or not reachable.',
          unsupported_contract: 'The installed updater speaks a different file contract than this version of PicPeak.',
          busy: 'An update is already in progress.'
        }[status.reason],
        status.reason === 'disabled' ? 403 : 409
      );
    }

    this.job = {
      id: crypto.randomUUID(),
      phase: 'backing_up',
      started_at: new Date().toISOString(),
      requested_by: admin.username,
      backup: null,
      error: null
    };
    const job = this.job;

    // Not awaited: a dump of a large database outlives any reverse proxy's
    // request timeout. The UI polls the status instead.
    this._run(job).catch((error) => {
      logger.error('Self-update job failed unexpectedly', { error: error.message });
    });
    return { ...job };
  }

  async _run(job) {
    // Required before the update, not best-effort: without it there is
    // nothing to restore if the new version's migrations go wrong.
    const { databaseBackupService } = require('./databaseBackup');
    try {
      const result = await databaseBackupService.backup({});
      job.backup = {
        file: path.basename(result.path),
        size: result.size
      };
    } catch (error) {
      job.phase = 'backup_failed';
      job.error = error.message;
      logger.error('Self-update: the database backup failed, no update was requested', { error: error.message });
      return;
    }

    try {
      await this.writeRequestFile();
    } catch (error) {
      job.phase = 'request_failed';
      job.error = error.message;
      logger.error('Self-update: could not write the update request', { error: error.message });
      return;
    }

    job.phase = 'requested';
    job.requested_at = new Date().toISOString();
    logger.info('Self-update requested', { by: job.requested_by, backup: job.backup?.file });
  }

  /**
   * Temp file plus rename, so the updater never sees a half-written marker
   * (it only checks existence, but the rename is what makes that true even
   * on filesystems that expose a file before the write completes).
   */
  async writeRequestFile() {
    const dir = path.dirname(this.requestFile);
    const tmp = path.join(dir, `.update-requested.${crypto.randomBytes(8).toString('hex')}.tmp`);
    await fs.promises.writeFile(tmp, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o640 });
    try {
      await fs.promises.rename(tmp, this.requestFile);
    } catch (error) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  // Tests only.
  _reset() {
    this.job = null;
  }
}

module.exports = new SelfUpdateService();
module.exports.SelfUpdateError = SelfUpdateError;
module.exports.CONTRACT_VERSION = CONTRACT_VERSION;

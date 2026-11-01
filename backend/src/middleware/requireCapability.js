'use strict';

const dependencyHealth = require('../services/dependencyHealth');
const { isCapability } = require('../services/capabilities');
const logger = require('../utils/logger');

const OBSERVE_LOG_INTERVAL_MS = 60_000;
const RETRY_AFTER_SECONDS = 60;
const lastObserved = new Map();

/**
 * Refuses a request while a capability is unavailable.
 *
 * Mount it AFTER the route's auth and access checks: this only ever adds a
 * refusal, and an anonymous caller must not learn the state of the server from
 * it. The answer names the capability and no dependency, for the same reason.
 *
 * In observe mode an automatic pause is logged, not applied. An admin's own
 * force-off always applies: they asked for it.
 */
function requireCapability(name) {
  if (!isCapability(name)) throw new Error(`Unknown capability: ${name}`);

  return function capabilityGuard(req, res, next) {
    if (!refuseCapability(res, name)) next();
  };
}

/**
 * The same decision for a route that can only tell partway through whether it
 * needs the capability. Answers the request and returns true when it refuses.
 */
function refuseCapability(res, name) {
  const decision = dependencyHealth.evaluate(name);
  if (decision.available) return false;

  if (dependencyHealth.enforcement !== 'enforce' && !decision.forced) {
    const now = Date.now();
    if (now - (lastObserved.get(name) || 0) >= OBSERVE_LOG_INTERVAL_MS) {
      lastObserved.set(name, now);
      logger.warn(`Would pause ${name} (observe mode)`, { blockedBy: decision.blockedBy });
    }
    return false;
  }

  res.set({ 'Retry-After': String(RETRY_AFTER_SECONDS), 'Cache-Control': 'no-store' });
  res.status(503).json({
    error: 'This feature is temporarily unavailable',
    code: 'CAPABILITY_UNAVAILABLE',
    capability: name,
  });
  return true;
}

module.exports = { requireCapability, refuseCapability };

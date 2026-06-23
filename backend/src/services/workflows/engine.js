/**
 * Workflow execution engine — walks a flow GRAPH (nodes + edges) per run.
 *
 * Node types: trigger | condition/branch | loop | wait | gate | action | webhook.
 * - condition/branch: run a registered condition → follow the yes/no edge.
 * - loop: increment a per-node counter in run.context → follow loop/exit edge
 *   (bounded by config.maxIterations — no infinite runs).
 * - wait: set status='waiting' + wake_at; the scheduler resumes it later.
 * - gate: set status='waiting'; an approval (email confirm/deny or the webview
 *   inbox) resumes it via the matching confirm/deny edge.
 * - action/webhook: dispatch to a registered action handler.
 *
 * Runs are idempotent (unique dedup_key per trigger+entity) and every node
 * writes a workflow_run_steps row for observability / System Health. Designed
 * to be called AFTER the caller's DB commit (emit never throws into callers).
 */
const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const registry = require('./registry');

const MAX_STEPS_PER_ADVANCE = 200;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

async function loadGraph(workflowId, version) {
  const nodes = await db('workflow_nodes').where({ workflow_id: workflowId, version });
  const edges = await db('workflow_edges').where({ workflow_id: workflowId, version });
  const nodeByKey = new Map(nodes.map((n) => [n.node_key, { ...n, config: parseJson(n.config, {}) }]));
  return { nodeByKey, edges };
}

// Pick the outgoing edge from `fromNode`. With a handle, prefer the matching
// handle; otherwise fall back to a default (null-handle) edge or the sole edge.
function outEdge(edges, fromNode, handle) {
  const candidates = edges.filter((e) => e.from_node === fromNode);
  if (handle != null) {
    const exact = candidates.find((e) => (e.from_handle || null) === handle);
    if (exact) return exact;
  }
  return candidates.find((e) => e.from_handle == null) || (candidates.length === 1 ? candidates[0] : null);
}

function computeWakeAt(config = {}, vars = {}) {
  const cfg = config || {};
  if (cfg.untilVar && vars[cfg.untilVar]) return new Date(vars[cfg.untilVar]).toISOString();
  const ms = (Number(cfg.delayDays || 0) * 86400000)
    + (Number(cfg.delayHours || 0) * 3600000)
    + (Number(cfg.delayMinutes || 0) * 60000);
  return new Date(Date.now() + ms).toISOString();
}

function gateTimeout(config = {}) {
  const days = Number((config || {}).timeoutDays || 0);
  return days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
}

function matchFilter(filter, payload) {
  if (!filter || typeof filter !== 'object') return true;
  const { field, op = 'eq', value } = filter;
  const actual = payload ? payload[field] : undefined;
  switch (op) {
    case 'neq': return actual != value; // eslint-disable-line eqeqeq
    case 'truthy': return Boolean(actual);
    case 'falsy': return !actual;
    case 'eq':
    default: return actual == value; // eslint-disable-line eqeqeq
  }
}

async function recordStep(runId, node, status, result, error) {
  await db('workflow_run_steps').insert({
    run_id: runId,
    node_key: node.node_key,
    node_type: node.type,
    status,
    result: result ? JSON.stringify(result) : null,
    error: error || null,
    finished_at: db.fn.now(),
  });
}

async function failRun(runId, error) {
  await db('workflow_runs').where({ id: runId }).update({ status: 'failed', error, finished_at: db.fn.now() });
  logger.error('[workflow] run failed', { runId, error });
}

async function finishRun(runId) {
  await db('workflow_runs').where({ id: runId }).update({ status: 'done', finished_at: db.fn.now() });
}

/**
 * Walk the graph from the run's current node until it ends, fails, or pauses
 * (wait / gate). Persists context + current_node after each node.
 */
async function advanceRun(runId) {
  let run = await db('workflow_runs').where({ id: runId }).first();
  if (!run || run.status !== 'running') return;
  const { nodeByKey, edges } = await loadGraph(run.workflow_id, run.version);
  const context = parseJson(run.context, { vars: {} });
  if (!context.vars) context.vars = {};

  let currentKey = run.current_node;
  let steps = 0;

  while (currentKey) {
    if (++steps > MAX_STEPS_PER_ADVANCE) { await failRun(runId, 'max steps per advance exceeded'); return; }
    const node = nodeByKey.get(currentKey);
    if (!node) { await failRun(runId, `node not found: ${currentKey}`); return; }

    const ctx = { run, node, vars: context.vars, db, logger };
    let nextKey = null;

    try {
      switch (node.type) {
        case 'trigger': {
          const e = outEdge(edges, currentKey, null);
          nextKey = e ? e.to_node : null;
          await recordStep(runId, node, 'done', null);
          break;
        }
        case 'condition':
        case 'branch': {
          const cond = registry.getCondition(node.config?.condition || 'expr');
          const result = cond ? await cond(ctx) : false;
          const handle = result ? (node.config?.trueHandle || 'yes') : (node.config?.falseHandle || 'no');
          const e = outEdge(edges, currentKey, handle) || outEdge(edges, currentKey, result ? 'true' : 'false');
          nextKey = e ? e.to_node : null;
          await recordStep(runId, node, 'done', { result, handle });
          break;
        }
        case 'loop': {
          const counterKey = `__loop_${node.node_key}`;
          const count = (Number(context.vars[counterKey]) || 0) + 1;
          context.vars[counterKey] = count;
          const max = Number(node.config?.maxIterations ?? node.config?.max ?? 3);
          const handle = count > max ? (node.config?.exitHandle || 'exit') : (node.config?.loopHandle || 'loop');
          const e = outEdge(edges, currentKey, handle);
          nextKey = e ? e.to_node : null;
          await recordStep(runId, node, 'done', { count, max, handle });
          break;
        }
        case 'wait': {
          const wakeAt = computeWakeAt(node.config, context.vars);
          await db('workflow_runs').where({ id: runId })
            .update({ status: 'waiting', wake_at: wakeAt, current_node: currentKey, context: JSON.stringify(context) });
          await recordStep(runId, node, 'waiting', { wake_at: wakeAt });
          return; // paused — scheduler resumes when wake_at passes
        }
        case 'gate': {
          await db('workflow_runs').where({ id: runId })
            .update({ status: 'waiting', wake_at: gateTimeout(node.config), current_node: currentKey, context: JSON.stringify(context) });
          await recordStep(runId, node, 'waiting', { gate: true });
          // Optional setup hook (create approval + send admin email) — registered
          // by the approval phase. Engine still pauses cleanly without it.
          const setup = registry.getAction('gate_setup');
          if (setup) {
            try { await setup(ctx); } catch (e) { logger.error('[workflow] gate setup failed', { runId, error: e.message }); }
          }
          return; // paused — an approval (email or inbox) resumes via resumeRun
        }
        case 'action':
        case 'webhook': {
          const actionKey = node.config?.action || (node.type === 'webhook' ? 'webhook' : 'noop');
          const action = registry.getAction(actionKey);
          const result = action ? (await action(ctx)) || {} : { skipped: true, reason: `unknown action ${actionKey}` };
          if (result.set && typeof result.set === 'object') Object.assign(context.vars, result.set);
          const e = outEdge(edges, currentKey, null);
          nextKey = e ? e.to_node : null;
          await recordStep(runId, node, result.skipped ? 'skipped' : 'done', result);
          break;
        }
        default: {
          await recordStep(runId, node, 'skipped', { reason: `unknown node type ${node.type}` });
          const e = outEdge(edges, currentKey, null);
          nextKey = e ? e.to_node : null;
        }
      }
    } catch (err) {
      await recordStep(runId, node, 'failed', null, err.message);
      await failRun(runId, `node ${currentKey} failed: ${err.message}`);
      return;
    }

    currentKey = nextKey;
    await db('workflow_runs').where({ id: runId }).update({ current_node: currentKey || null, context: JSON.stringify(context) });
  }

  await finishRun(runId);
}

/** Begin a freshly-created run at its trigger node. */
async function startRun(runId) {
  const run = await db('workflow_runs').where({ id: runId }).first();
  if (!run || ['done', 'failed', 'cancelled'].includes(run.status)) return;
  const { nodeByKey } = await loadGraph(run.workflow_id, run.version);
  let entry = null;
  for (const n of nodeByKey.values()) { if (n.type === 'trigger') { entry = n; break; } }
  if (!entry) { await failRun(runId, 'no trigger node'); return; }
  await db('workflow_runs').where({ id: runId }).update({ status: 'running', current_node: entry.node_key });
  await advanceRun(runId);
}

/**
 * Resume a paused (waiting) run. For a wait node, pass no handle. For a gate,
 * pass decisionHandle = 'confirm' | 'deny' so the matching edge is taken.
 */
async function resumeRun(runId, { decisionHandle = null } = {}) {
  const run = await db('workflow_runs').where({ id: runId }).first();
  if (!run || run.status !== 'waiting') return;
  const { edges } = await loadGraph(run.workflow_id, run.version);
  const e = outEdge(edges, run.current_node, decisionHandle);
  const nextKey = e ? e.to_node : null;
  await db('workflow_runs').where({ id: runId }).update({ status: 'running', current_node: nextKey, wake_at: null });
  if (!nextKey) { await finishRun(runId); return; }
  await advanceRun(runId);
}

/**
 * Entry point for lifecycle events. Creates one run per matching enabled
 * workflow (idempotent via dedup_key) and starts it. Never throws — safe to
 * call after a caller's commit. Fails CLOSED if the flag system is unavailable.
 */
async function emitWorkflowEvent(triggerType, { entityType = null, entityId = null, payload = {} } = {}) {
  try {
    const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
    let enabled = false;
    try { enabled = await isFeatureEnabled('workflows'); } catch (e) {
      logger.warn('[workflow] flag check failed — treating workflows as disabled', { error: e.message });
      return [];
    }
    if (!enabled) return [];

    const workflows = await db('workflows').where({ enabled: true, trigger_type: triggerType });
    const runIds = [];
    for (const wf of workflows) {
      const tcfg = parseJson(wf.trigger_config, {});
      if (tcfg && tcfg.filter && !matchFilter(tcfg.filter, payload)) continue;

      const dedupKey = `${wf.id}:${wf.version}:${triggerType}:${entityType || ''}:${entityId || ''}`;
      const existing = await db('workflow_runs').where({ dedup_key: dedupKey }).first();
      if (existing) continue;

      try {
        await db('workflow_runs').insert({
          workflow_id: wf.id,
          version: wf.version,
          trigger_event: triggerType,
          entity_type: entityType,
          entity_id: entityId,
          status: 'pending',
          context: JSON.stringify({ vars: { ...payload } }),
          dedup_key: dedupKey,
        });
      } catch (e) {
        continue; // unique race — another emitter created it
      }
      const row = await db('workflow_runs').where({ dedup_key: dedupKey }).first();
      if (!row) continue;
      runIds.push(row.id);
      await startRun(row.id).catch((err) => logger.error('[workflow] start failed', { runId: row.id, error: err.message }));
    }
    return runIds;
  } catch (e) {
    logger.error('[workflow] emit failed', { triggerType, error: e.message });
    return [];
  }
}

module.exports = {
  emitWorkflowEvent,
  startRun,
  advanceRun,
  resumeRun,
  finishRun,
  failRun,
  // exported for tests / introspection
  loadGraph,
  outEdge,
  computeWakeAt,
};

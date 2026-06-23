/**
 * Workflow engine — graph execution integration tests.
 *
 * Exercises the engine against a real (temp SQLite) DB with migration 142
 * applied: branching, bounded loops, wait pauses + scheduler-style resume,
 * gate pauses + confirm/deny resume, dedup idempotency, and step recording.
 */
const { bootCrmDb } = require('./helpers/crmDb');

let db;
let cleanup;
let engine;

async function makeWorkflow({ nodes, edges, trigger = 'test.event', enabled = true }) {
  const ins = await db('workflows').insert({ name: 'wf', trigger_type: trigger, version: 1, enabled });
  const workflowId = ins[0];
  for (const n of nodes) {
    await db('workflow_nodes').insert({
      workflow_id: workflowId, version: 1, node_key: n.key, type: n.type,
      config: JSON.stringify(n.config || {}),
    });
  }
  for (const e of edges) {
    await db('workflow_edges').insert({
      workflow_id: workflowId, version: 1, from_node: e.from, from_handle: e.handle || null, to_node: e.to,
      loop_back: e.loopBack || false,
    });
  }
  return workflowId;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  // Engine requires the singleton db — require AFTER bootCrmDb wired the test path.
  engine = require('../../src/services/workflows');
  // Enable the workflows flag so emitWorkflowEvent doesn't fail closed.
  await db('feature_flags').insert({ key: 'workflows', value: true });
});

afterAll(async () => { await cleanup(); });

describe('workflow engine', () => {
  test('condition + bounded loop + wait pauses, resumes to completion', async () => {
    // trigger → set paid=false → condition(paid?) --no--> loop(max2)
    //   loop --loop--> reminder(noop) → wait → (back to condition)
    //   loop --exit--> lateFee(noop) → end
    //   condition --yes--> lateFee (paid path, not taken here)
    const wfId = await makeWorkflow({
      nodes: [
        { key: 'n1', type: 'trigger' },
        { key: 'n2', type: 'action', config: { action: 'set_context', set: { paid: false } } },
        { key: 'n3', type: 'condition', config: { condition: 'expr', field: 'paid', op: 'truthy' } },
        { key: 'n4', type: 'loop', config: { maxIterations: 2 } },
        { key: 'n5', type: 'action', config: { action: 'noop' } },
        { key: 'n6', type: 'wait', config: { delayMinutes: 0 } },
        { key: 'n7', type: 'action', config: { action: 'noop' } },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', handle: 'no', to: 'n4' },
        { from: 'n3', handle: 'yes', to: 'n7' },
        { from: 'n4', handle: 'loop', to: 'n5' },
        { from: 'n4', handle: 'exit', to: 'n7' },
        { from: 'n5', to: 'n6' },
        { from: 'n6', to: 'n3', loopBack: true },
      ],
    });

    const runIds = await engine.emitWorkflowEvent('test.event', { entityType: 'invoice', entityId: 1 });
    expect(runIds.length).toBe(1);
    const runId = runIds[0];

    let run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('waiting');     // paused at first wait (loop iter 1)
    expect(run.current_node).toBe('n6');

    await engine.resumeRun(runId);
    run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('waiting');     // paused again (loop iter 2)

    await engine.resumeRun(runId);
    run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('done');        // loop exhausted → exit → end

    const ctx = JSON.parse(run.context);
    expect(ctx.vars.__loop_n4).toBe(3);     // counter incremented past the cap
    void wfId;

    const steps = await db('workflow_run_steps').where({ run_id: runId });
    expect(steps.length).toBeGreaterThan(0);
  });

  test('emit is idempotent on dedup_key', async () => {
    await makeWorkflow({
      trigger: 'dedup.event',
      nodes: [{ key: 'n1', type: 'trigger' }, { key: 'n2', type: 'action', config: { action: 'noop' } }],
      edges: [{ from: 'n1', to: 'n2' }],
    });
    const first = await engine.emitWorkflowEvent('dedup.event', { entityType: 'x', entityId: 9 });
    const second = await engine.emitWorkflowEvent('dedup.event', { entityType: 'x', entityId: 9 });
    expect(first.length).toBe(1);
    expect(second.length).toBe(0); // same entity → no duplicate run
  });

  test('gate pauses and resumes via the confirm edge', async () => {
    const wfId = await makeWorkflow({
      trigger: 'gate.event',
      nodes: [
        { key: 'g1', type: 'trigger' },
        { key: 'g2', type: 'gate', config: { type: 'payment_confirm' } },
        { key: 'g3', type: 'action', config: { action: 'noop' } },
        { key: 'g4', type: 'action', config: { action: 'noop' } },
      ],
      edges: [
        { from: 'g1', to: 'g2' },
        { from: 'g2', handle: 'confirm', to: 'g3' },
        { from: 'g2', handle: 'deny', to: 'g4' },
      ],
    });
    // create + start a run directly
    await db('workflow_runs').insert({
      workflow_id: wfId, version: 1, trigger_event: 'gate.event', status: 'pending',
      context: JSON.stringify({ vars: {} }), dedup_key: 'gate-test',
    });
    const run0 = await db('workflow_runs').where({ dedup_key: 'gate-test' }).first();
    await engine.startRun(run0.id);

    let run = await db('workflow_runs').where({ id: run0.id }).first();
    expect(run.status).toBe('waiting');
    expect(run.current_node).toBe('g2');

    await engine.resumeRun(run0.id, { decisionHandle: 'confirm' });
    run = await db('workflow_runs').where({ id: run0.id }).first();
    expect(run.status).toBe('done');
  });
});

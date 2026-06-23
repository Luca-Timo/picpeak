/**
 * Workflow engine — graph execution integration tests.
 *
 * Exercises the engine against a real (temp SQLite) DB with migration 142
 * applied: branching, bounded loops, wait pauses + scheduler-style resume,
 * gate pauses + confirm/deny resume, dedup idempotency, and step recording.
 */
const { bootCrmDb } = require('./helpers/crmDb');

// bootCrmDb runs the full core-migration set in beforeAll; under full-suite
// parallel load on a small CI runner that can exceed the 5s default. Match the
// other migration-heavy CRM suites (discountLineItems, incomingInvoiceRebill).
jest.setTimeout(30000);

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

  test('runDueWaits resumes only elapsed wait nodes', async () => {
    await makeWorkflow({
      trigger: 'wait.event',
      nodes: [
        { key: 'w1', type: 'trigger' },
        { key: 'w2', type: 'wait', config: { delayMinutes: 60 } },
        { key: 'w3', type: 'action', config: { action: 'noop' } },
      ],
      edges: [{ from: 'w1', to: 'w2' }, { from: 'w2', to: 'w3' }],
    });
    const runIds = await engine.emitWorkflowEvent('wait.event', { entityType: 'e', entityId: 7 });
    const runId = runIds[0];
    let run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('waiting');

    expect(await engine.runDueWaits()).toBe(0); // wake_at ~60min out → not due

    await db('workflow_runs').where({ id: runId }).update({ wake_at: new Date(Date.now() - 1000).toISOString() });
    const resumed = await engine.runDueWaits();
    expect(resumed).toBeGreaterThanOrEqual(1);
    run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('done');
  });

  test('send_email queues a customer mail with business-hours routing', async () => {
    await makeWorkflow({
      trigger: 'mail.event',
      nodes: [
        { key: 'm1', type: 'trigger' },
        { key: 'm2', type: 'action', config: { action: 'send_email', recipientClass: 'customer', emailType: 'workflow_test' } },
      ],
      edges: [{ from: 'm1', to: 'm2' }],
    });
    const runIds = await engine.emitWorkflowEvent('mail.event', {
      entityType: 'invoice', entityId: 3, payload: { customerEmail: 'cust@example.com' },
    });
    const run = await db('workflow_runs').where({ id: runIds[0] }).first();
    expect(run.status).toBe('done');
    const queued = await db('email_queue').where({ recipient_email: 'cust@example.com' }).first();
    expect(queued).toBeTruthy();
    const step = await db('workflow_run_steps').where({ run_id: runIds[0], node_key: 'm2' }).first();
    expect(JSON.parse(step.result).respectBusinessHours).toBe(true);
  });

  test('invoice_paid condition reads the entity', async () => {
    const registry = require('../../src/services/workflows/registry');
    const cond = registry.getCondition('invoice_paid');
    const makeCtx = (row) => ({ run: { entity_id: 1 }, db: () => ({ where: () => ({ first: async () => row }) }) });
    expect(await cond(makeCtx({ paid_at: '2026-01-01', status: 'sent' }))).toBe(true);
    expect(await cond(makeCtx({ paid_at: null, status: 'paid' }))).toBe(true);
    expect(await cond(makeCtx({ paid_at: null, status: 'sent', paid_amount_minor: 0, total_amount_minor: 1000 }))).toBe(false);
  });

  test('gate creates a pending approval + admin email, token confirm resumes the run', async () => {
    await makeWorkflow({
      trigger: 'approval.event',
      nodes: [
        { key: 'a1', type: 'trigger' },
        { key: 'a2', type: 'gate', config: { type: 'payment_confirm', prompt: 'No payment yet?' } },
        { key: 'a3', type: 'action', config: { action: 'noop' } }, // confirm path
        { key: 'a4', type: 'action', config: { action: 'noop' } }, // deny path
      ],
      edges: [
        { from: 'a1', to: 'a2' },
        { from: 'a2', handle: 'confirm', to: 'a3' },
        { from: 'a2', handle: 'deny', to: 'a4' },
      ],
    });
    const runIds = await engine.emitWorkflowEvent('approval.event', {
      entityType: 'invoice', entityId: 42, payload: { adminEmail: 'admin@example.com' },
    });
    const runId = runIds[0];

    let run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('waiting');
    expect(run.current_node).toBe('a2');

    const approval = await db('workflow_approvals').where({ run_id: runId }).first();
    expect(approval).toBeTruthy();
    expect(approval.status).toBe('pending');

    const adminMail = await db('email_queue').where({ recipient_email: 'admin@example.com' }).first();
    expect(adminMail).toBeTruthy();

    // Extract the raw token from the emailed confirm link and act on it.
    const data = JSON.parse(adminMail.email_data);
    const rawToken = data.confirm_url.split('/').slice(-2)[0];
    const res = await engine.actByToken(rawToken, 'confirm');
    expect(res.ok).toBe(true);
    expect(res.status).toBe('confirmed');

    run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('done');

    // A second click is idempotent (already recorded).
    const again = await engine.actByToken(rawToken, 'confirm');
    expect(again.already).toBe(true);
  });

  test('seeds the invoice-dunning built-in as the delegation graph (v2, disabled)', async () => {
    const { seedBuiltinWorkflowsAtBoot, DUNNING_KEY } = require('../../src/services/_workflowSeedBoot');
    const noopLogger = { info() {}, warn() {} };
    await seedBuiltinWorkflowsAtBoot(db, noopLogger);

    const wf = await db('workflows').where({ builtin_key: DUNNING_KEY }).first();
    expect(wf).toBeTruthy();
    expect(!!wf.is_builtin).toBe(true);
    expect(!!wf.enabled).toBe(false);
    expect(JSON.parse(wf.trigger_config).seedVersion).toBe(4);

    const nodes = await db('workflow_nodes').where({ workflow_id: wf.id, version: wf.version });
    expect(nodes.filter((n) => n.type === 'trigger')).toHaveLength(1);
    expect(nodes.some((n) => n.type === 'gate')).toBe(false); // payment-check email IS the gate
    expect(nodes.some((n) => JSON.parse(n.config || '{}').action === 'queue_payment_check')).toBe(true);
    expect(nodes.some((n) => JSON.parse(n.config || '{}').action === 'escalate_to_collections')).toBe(true);

    await seedBuiltinWorkflowsAtBoot(db, noopLogger); // idempotent at current seed version
    const all = await db('workflows').where({ builtin_key: DUNNING_KEY });
    expect(all.length).toBe(1);
  });

  test('re-seeds a disabled, stale built-in but never an enabled one', async () => {
    const { seedBuiltinWorkflowsAtBoot, DUNNING_KEY } = require('../../src/services/_workflowSeedBoot');
    const noopLogger = { info() {}, warn() {} };

    // Simulate an older, never-activated seed (v1, with a legacy gate node).
    const wf = await db('workflows').where({ builtin_key: DUNNING_KEY }).first();
    await db('workflows').where({ id: wf.id }).update({ enabled: false, trigger_config: JSON.stringify({ seedVersion: 1 }) });
    await db('workflow_nodes').insert({ workflow_id: wf.id, version: wf.version, node_key: 'legacyGate', type: 'gate', config: '{}', pos_x: 0, pos_y: 0 });

    await seedBuiltinWorkflowsAtBoot(db, noopLogger);
    const reseeded = await db('workflows').where({ id: wf.id }).first();
    expect(reseeded.version).toBe(wf.version + 1); // bumped
    expect(JSON.parse(reseeded.trigger_config).seedVersion).toBe(4);
    const newNodes = await db('workflow_nodes').where({ workflow_id: wf.id, version: reseeded.version });
    expect(newNodes.some((n) => n.type === 'gate')).toBe(false); // legacy graph replaced

    // Enabled + stale → must NOT be touched (it's the admin's live flow).
    await db('workflows').where({ id: wf.id }).update({ enabled: true, trigger_config: JSON.stringify({ seedVersion: 1 }) });
    const before = await db('workflows').where({ id: wf.id }).first();
    await seedBuiltinWorkflowsAtBoot(db, noopLogger);
    const after = await db('workflows').where({ id: wf.id }).first();
    expect(after.version).toBe(before.version); // unchanged
  });

  test('seeds the booking + pre-event built-ins (disabled, correct triggers)', async () => {
    const { seedBuiltinWorkflowsAtBoot } = require('../../src/services/_workflowSeedBoot');
    await seedBuiltinWorkflowsAtBoot(db, { info() {}, warn() {} });

    const bookingFull = await db('workflows').where({ builtin_key: 'booking_full' }).first();
    expect(bookingFull).toBeTruthy();
    expect(!!bookingFull.enabled).toBe(false);
    expect(bookingFull.trigger_type).toBe('quote.accepted');
    const fullNodes = await db('workflow_nodes').where({ workflow_id: bookingFull.id, version: bookingFull.version });
    expect(fullNodes.some((n) => JSON.parse(n.config || '{}').action === 'prepare_contract')).toBe(true);
    // Admin review gate guards BOTH document sends (adjust line items, then OK).
    const fullGateKeys = fullNodes.filter((n) => n.type === 'gate').map((n) => n.node_key);
    expect(fullGateKeys).toEqual(expect.arrayContaining(['reviewContract', 'reviewInvoice']));
    const fullEdges = await db('workflow_edges').where({ workflow_id: bookingFull.id, version: bookingFull.version });
    // reviewContract --confirm--> sendContract ; reviewInvoice --confirm--> sendInvoice
    expect(fullEdges.some((e) => e.from_node === 'reviewContract' && e.from_handle === 'confirm' && e.to_node === 'sendContract')).toBe(true);
    expect(fullEdges.some((e) => e.from_node === 'reviewInvoice' && e.from_handle === 'confirm' && e.to_node === 'sendInvoice')).toBe(true);

    const bookingSimple = await db('workflows').where({ builtin_key: 'booking_simple' }).first();
    expect(bookingSimple).toBeTruthy();
    expect(bookingSimple.trigger_type).toBe('quote.accepted');
    const simpleEdges = await db('workflow_edges').where({ workflow_id: bookingSimple.id, version: bookingSimple.version });
    expect(simpleEdges.some((e) => e.from_node === 'reviewInvoice' && e.from_handle === 'confirm' && e.to_node === 'sendInvoice')).toBe(true);

    const preEvent = await db('workflows').where({ builtin_key: 'pre_event_email' }).first();
    expect(preEvent).toBeTruthy();
    expect(preEvent.trigger_type).toBe('event.date_approaching');
    expect(JSON.parse(preEvent.trigger_config).daysBefore).toBe(3);
    const preNodes = await db('workflow_nodes').where({ workflow_id: preEvent.id, version: preEvent.version });
    expect(preNodes.some((n) => JSON.parse(n.config || '{}').action === 'send_email')).toBe(true);
  });

  test('emitDueEventReminders starts a run for an event inside the lead window', async () => {
    const wfId = await makeWorkflow({
      trigger: 'event.date_approaching',
      enabled: true,
      nodes: [{ key: 'pe1', type: 'trigger' }, { key: 'pe2', type: 'action', config: { action: 'noop' } }],
      edges: [{ from: 'pe1', to: 'pe2' }],
    });
    // Park the workflow's trigger window at 5 days so our event (2 days out) is in range.
    await db('workflows').where({ id: wfId }).update({ trigger_config: JSON.stringify({ daysBefore: 5 }) });

    const inWindow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const tooFar = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const farFuture = new Date(Date.now() + 365 * 86400000).toISOString();
    const evt = { event_type: 'wedding', password_hash: 'x', expires_at: farFuture, is_active: true, is_archived: false, customer_email: 'c@x.test' };
    await db('events').insert({ ...evt, slug: 'pe-soon', share_link: 'pe-soon', event_name: 'Soon', event_date: inWindow });
    await db('events').insert({ ...evt, slug: 'pe-far', share_link: 'pe-far', event_name: 'Far', event_date: tooFar });

    const emitted = await engine.emitDueEventReminders();
    expect(emitted).toBeGreaterThanOrEqual(1);

    const runs = await db('workflow_runs').where({ workflow_id: wfId, entity_type: 'event' });
    expect(runs.length).toBe(1); // only the in-window event, not the far one

    // Idempotent: a second pass dedups (no duplicate run for the same event).
    await engine.emitDueEventReminders();
    const runs2 = await db('workflow_runs').where({ workflow_id: wfId, entity_type: 'event' });
    expect(runs2.length).toBe(1);
  });

  test('recoverStaleRuns resumes a run orphaned mid-flow (crash recovery)', async () => {
    const wfId = await makeWorkflow({
      trigger: 'recover.event',
      nodes: [{ key: 'r1', type: 'trigger' }, { key: 'r2', type: 'action', config: { action: 'noop' } }],
      edges: [{ from: 'r1', to: 'r2' }],
    });
    // Simulate a run left 'running' at r2 with a stale heartbeat (crash mid-flow).
    await db('workflow_runs').insert({
      workflow_id: wfId, version: 1, trigger_event: 'recover.event', status: 'running', current_node: 'r2',
      context: JSON.stringify({ vars: {} }), dedup_key: 'recover-1',
      updated_at: new Date(Date.now() - 3600000).toISOString(),
    });
    const run0 = await db('workflow_runs').where({ dedup_key: 'recover-1' }).first();
    const n = await engine.recoverStaleRuns({ staleMs: 1000 });
    expect(n).toBeGreaterThanOrEqual(1);
    const run = await db('workflow_runs').where({ id: run0.id }).first();
    expect(run.status).toBe('done');
  });

  test('recoverStaleRuns abandons a crash-looping run after the attempts cap', async () => {
    const wfId = await makeWorkflow({
      trigger: 'crashloop.event',
      nodes: [{ key: 'c1', type: 'trigger' }, { key: 'c2', type: 'action', config: { action: 'noop' } }],
      edges: [{ from: 'c1', to: 'c2' }],
    });
    await db('workflow_runs').insert({
      workflow_id: wfId, version: 1, trigger_event: 'crashloop.event', status: 'running', current_node: 'c2',
      context: JSON.stringify({ vars: {} }), dedup_key: 'crash-1', attempts: 5,
      updated_at: new Date(Date.now() - 3600000).toISOString(),
    });
    const run0 = await db('workflow_runs').where({ dedup_key: 'crash-1' }).first();
    await engine.recoverStaleRuns({ staleMs: 1000 });
    const run = await db('workflow_runs').where({ id: run0.id }).first();
    expect(run.status).toBe('failed');
  });

  test('testRun dry-run walks the whole flow (waits skipped, gate auto-confirmed, actions mocked)', async () => {
    const wfId = await makeWorkflow({
      trigger: 'testfire.event',
      nodes: [
        { key: 't', type: 'trigger' },
        { key: 'w', type: 'wait', config: { delayDays: 14 } },
        { key: 'g', type: 'gate', config: { type: 'payment_confirm' } },
        { key: 'a', type: 'action', config: { action: 'send_email', recipientClass: 'customer' } },
        { key: 'end', type: 'action', config: { action: 'noop' } },
      ],
      edges: [
        { from: 't', to: 'w' },
        { from: 'w', to: 'g' },
        { from: 'g', handle: 'confirm', to: 'a' },
        { from: 'g', handle: 'deny', to: 'end' },
        { from: 'a', to: 'end' },
      ],
    });
    const runId = await engine.testRun(wfId, { dryRun: true });
    const run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('done'); // walked to completion — no parking at the wait/gate

    const steps = await db('workflow_run_steps').where({ run_id: runId });
    expect(steps.find((s) => s.node_key === 'w').status).toBe('skipped'); // wait passed through
    const emailStep = steps.find((s) => s.node_key === 'a');
    expect(JSON.parse(emailStep.result).dryRun).toBe(true); // send_email mocked, no real mail
  });
});

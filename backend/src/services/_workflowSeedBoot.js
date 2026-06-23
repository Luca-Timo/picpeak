/**
 * Boot-time seed for built-in workflows.
 *
 * Seeds the reminder/booking ladders as EDITABLE built-in flows, so the canvas
 * has real content and admins can see (and tweak) their processes as blocks.
 *
 * IMPORTANT — every built-in is seeded DISABLED. Live behaviour is UNCHANGED
 * until an admin enables a flow: the hardcoded reminder ladder still runs, and
 * the booking document actions (prepare_quote/contract/event/invoice) are still
 * stubs that record an observable `skipped` step rather than firing. The
 * cutover (drive each process through the engine + stop the hardcoded path) is a
 * deliberate follow-up so we never double-act. Enabling a flow before its
 * cutover is safe — at worst it records skipped steps — but the dunning flow in
 * particular auto-suppresses the hardcoded ladder while enabled so the two never
 * double-send.
 *
 * Idempotent: keyed on builtin_key. Once seeded, admin edits are preserved (we
 * never overwrite an enabled built-in, and re-seed a disabled one only when its
 * SEED_VERSION moves on). Self-heal pattern per [[feedback_self_heal_pattern]].
 */
const { getAppSetting } = require('../utils/appSettings');

const DUNNING_KEY = 'invoice_dunning';

function buildDunningGraph({ firstDays, gapDays, maxReminders }) {
  // Delegation model: the payment-check email IS the admin gate (it drives the
  // existing confirm + reminder_level + Mahngebühr state machine), so the flow
  // just decides WHEN to fire it. After due date + grace, loop up to
  // maxReminders times: if still unpaid, queue a payment-check, wait the gap,
  // repeat; stop early once paid. After the loop exhausts → collections handoff.
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 240, pos_y: 0 },
    { node_key: 'waitDue', type: 'wait', config: { untilVar: 'dueDate' }, pos_x: 240, pos_y: 110 },
    { node_key: 'waitGrace', type: 'wait', config: { delayDays: firstDays }, pos_x: 240, pos_y: 220 },
    { node_key: 'loop', type: 'loop', config: { maxIterations: maxReminders }, pos_x: 240, pos_y: 330 },
    { node_key: 'checkPaid', type: 'condition', config: { condition: 'invoice_paid' }, pos_x: 240, pos_y: 440 },
    { node_key: 'paymentCheck', type: 'action', config: { action: 'queue_payment_check' }, pos_x: 240, pos_y: 550 },
    { node_key: 'waitGap', type: 'wait', config: { delayDays: gapDays }, pos_x: 240, pos_y: 660 },
    { node_key: 'donePaid', type: 'action', config: { action: 'noop' }, pos_x: 520, pos_y: 440 },
    { node_key: 'collections', type: 'action', config: { action: 'escalate_to_collections' }, pos_x: 520, pos_y: 250 },
    { node_key: 'doneEnd', type: 'action', config: { action: 'noop' }, pos_x: 760, pos_y: 250 },
  ];
  const edges = [
    { from_node: 't', to_node: 'waitDue' },
    { from_node: 'waitDue', to_node: 'waitGrace' },
    { from_node: 'waitGrace', to_node: 'loop' },
    { from_node: 'loop', from_handle: 'loop', to_node: 'checkPaid' },
    { from_node: 'loop', from_handle: 'exit', to_node: 'collections' },
    { from_node: 'collections', to_node: 'doneEnd' },
    { from_node: 'checkPaid', from_handle: 'yes', to_node: 'donePaid' },
    { from_node: 'checkPaid', from_handle: 'no', to_node: 'paymentCheck' },
    { from_node: 'paymentCheck', to_node: 'waitGap' },
    { from_node: 'waitGap', to_node: 'loop', loop_back: true },
  ];
  return { nodes, edges };
}

// Booking — quote accepted → prepare contract → ADMIN REVIEW GATE → send
// contract → admin gate "signed?" → create the event/gallery → wait to the
// event date → prepare invoice → ADMIN REVIEW GATE → send invoice.
//
// A document is never sent without an explicit admin OK: prepare_* creates a
// DRAFT, the admin adjusts line items / terms in the CRM, then confirms the
// review gate, and only then does send_document fire. The "signed?" gate models
// the external signing step (no e-sign webhook yet). The document actions are
// stubs until the booking cutover, so an enabled run records observable skipped
// steps rather than acting.
function buildBookingFullGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 320, pos_y: 0 },
    { node_key: 'prepContract', type: 'action', config: { action: 'prepare_contract' }, pos_x: 320, pos_y: 110 },
    { node_key: 'reviewContract', type: 'gate', config: { label: 'Review contract before sending' }, pos_x: 320, pos_y: 220 },
    { node_key: 'sendContract', type: 'action', config: { action: 'send_document', document: 'contract', recipient: 'customer' }, pos_x: 320, pos_y: 330 },
    { node_key: 'gateSigned', type: 'gate', config: { label: 'Contract signed?' }, pos_x: 320, pos_y: 440 },
    { node_key: 'prepEvent', type: 'action', config: { action: 'prepare_event' }, pos_x: 320, pos_y: 550 },
    { node_key: 'waitEvent', type: 'wait', config: { untilVar: 'eventDate' }, pos_x: 320, pos_y: 660 },
    { node_key: 'prepInvoice', type: 'action', config: { action: 'prepare_invoice' }, pos_x: 320, pos_y: 770 },
    { node_key: 'reviewInvoice', type: 'gate', config: { label: 'Review invoice before sending' }, pos_x: 320, pos_y: 880 },
    { node_key: 'sendInvoice', type: 'action', config: { action: 'send_document', document: 'invoice', recipient: 'customer' }, pos_x: 320, pos_y: 990 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 320, pos_y: 1100 },
    { node_key: 'cancelContract', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 220 },
    { node_key: 'declined', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 440 },
    { node_key: 'cancelInvoice', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 880 },
  ];
  const edges = [
    { from_node: 't', to_node: 'prepContract' },
    { from_node: 'prepContract', to_node: 'reviewContract' },
    { from_node: 'reviewContract', from_handle: 'confirm', to_node: 'sendContract' },
    { from_node: 'reviewContract', from_handle: 'deny', to_node: 'cancelContract' },
    { from_node: 'sendContract', to_node: 'gateSigned' },
    { from_node: 'gateSigned', from_handle: 'confirm', to_node: 'prepEvent' },
    { from_node: 'gateSigned', from_handle: 'deny', to_node: 'declined' },
    { from_node: 'prepEvent', to_node: 'waitEvent' },
    { from_node: 'waitEvent', to_node: 'prepInvoice' },
    { from_node: 'prepInvoice', to_node: 'reviewInvoice' },
    { from_node: 'reviewInvoice', from_handle: 'confirm', to_node: 'sendInvoice' },
    { from_node: 'reviewInvoice', from_handle: 'deny', to_node: 'cancelInvoice' },
    { from_node: 'sendInvoice', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Booking — quote accepted → create the event/gallery → wait to the event date
// → prepare invoice → ADMIN REVIEW GATE → send invoice. The no-contract path
// (e.g. small shoots). Same review-before-send rule and stub caveat as the full
// booking flow.
function buildBookingSimpleGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 320, pos_y: 0 },
    { node_key: 'prepEvent', type: 'action', config: { action: 'prepare_event' }, pos_x: 320, pos_y: 110 },
    { node_key: 'waitEvent', type: 'wait', config: { untilVar: 'eventDate' }, pos_x: 320, pos_y: 220 },
    { node_key: 'prepInvoice', type: 'action', config: { action: 'prepare_invoice' }, pos_x: 320, pos_y: 330 },
    { node_key: 'reviewInvoice', type: 'gate', config: { label: 'Review invoice before sending' }, pos_x: 320, pos_y: 440 },
    { node_key: 'sendInvoice', type: 'action', config: { action: 'send_document', document: 'invoice', recipient: 'customer' }, pos_x: 320, pos_y: 550 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 320, pos_y: 660 },
    { node_key: 'cancelInvoice', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 440 },
  ];
  const edges = [
    { from_node: 't', to_node: 'prepEvent' },
    { from_node: 'prepEvent', to_node: 'waitEvent' },
    { from_node: 'waitEvent', to_node: 'prepInvoice' },
    { from_node: 'prepInvoice', to_node: 'reviewInvoice' },
    { from_node: 'reviewInvoice', from_handle: 'confirm', to_node: 'sendInvoice' },
    { from_node: 'reviewInvoice', from_handle: 'deny', to_node: 'cancelInvoice' },
    { from_node: 'sendInvoice', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Pre-event email — fired by the scheduler `daysBefore` the event date (see
// emitDueEventReminders in the engine). Sends a customer reminder, then a heads-
// up to the admin. Unlike the booking flows this uses the already-wired
// send_email action, so it is functional once enabled (the customer template
// `pre_event_reminder` should exist / be authored).
function buildPreEventEmailGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 240, pos_y: 0 },
    { node_key: 'emailCustomer', type: 'action', config: { action: 'send_email', recipientClass: 'customer', emailType: 'pre_event_reminder' }, pos_x: 240, pos_y: 110 },
    { node_key: 'emailAdmin', type: 'action', config: { action: 'send_email', recipientClass: 'admin', emailType: 'pre_event_internal' }, pos_x: 240, pos_y: 220 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 240, pos_y: 330 },
  ];
  const edges = [
    { from_node: 't', to_node: 'emailCustomer' },
    { from_node: 'emailCustomer', to_node: 'emailAdmin' },
    { from_node: 'emailAdmin', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Built-in registry. `version` is the SEED_VERSION — bump when a graph changes
// so a disabled, never-activated copy is re-seeded on boot.
//   invoice_dunning v4 = collections handoff after the loop exhausts.
const BUILTINS = [
  {
    key: DUNNING_KEY,
    version: 4,
    name: 'Invoice dunning (built-in)',
    trigger_type: 'invoice.sent',
    trigger_config: {},
    description:
      'Drives overdue dunning through the engine: wait to the due date, then up to '
      + 'three payment-check cycles. Each cycle fires the existing admin confirm-payment '
      + 'email (the gate), which applies reminders + Mahngebühr via the proven payment-check '
      + 'flow; after the cycles exhaust it hands the case to collections. Disabled by default; '
      + 'while it is enabled the hardcoded reminder ladder is skipped automatically, so the two '
      + 'never double-send.',
    build: async () => {
      const firstDays = Number(await getAppSetting('crm_invoices_reminder_first_days')) || 14;
      const secondDays = Number(await getAppSetting('crm_invoices_reminder_second_days')) || 30;
      const gapDays = Math.max(1, secondDays - firstDays);
      return buildDunningGraph({ firstDays, gapDays, maxReminders: 3 });
    },
  },
  {
    key: 'booking_full',
    version: 2,
    name: 'Booking — quote → contract → event → invoice (built-in)',
    trigger_type: 'quote.accepted',
    trigger_config: {},
    description:
      'On quote acceptance: prepare the contract, let the admin review it (adjust line items / '
      + 'terms) and confirm before it is sent, wait for the admin to confirm it is signed, then '
      + 'create the event/gallery, wait to the shoot date, prepare the invoice and — after a '
      + 'second admin review gate — send it. No document is ever sent without an explicit admin '
      + 'OK. Disabled by default — the document actions are stubs until the booking cutover, so '
      + 'an enabled run just records observable skipped steps. A starting point to edit.',
    build: async () => buildBookingFullGraph(),
  },
  {
    key: 'booking_simple',
    version: 2,
    name: 'Booking — quote → event → invoice (built-in)',
    trigger_type: 'quote.accepted',
    trigger_config: {},
    description:
      'The no-contract booking path: on quote acceptance create the event/gallery, wait to the '
      + 'shoot date, prepare the invoice and — after an admin review gate — send it. Same '
      + 'review-before-send rule and stub caveat as the full booking flow; disabled by default.',
    build: async () => buildBookingSimpleGraph(),
  },
  {
    key: 'pre_event_email',
    version: 1,
    name: 'Pre-event email (built-in)',
    trigger_type: 'event.date_approaching',
    // daysBefore drives the scheduler emitter — how many days before the event
    // date the reminder fires.
    trigger_config: { daysBefore: 3 },
    description:
      'A few days before the event date, send the customer a reminder and the admin a heads-up. '
      + 'Fired by the scheduler from the event date (daysBefore in the trigger config). Uses the '
      + 'wired send_email action, so it works once enabled and the pre_event_reminder template '
      + 'exists. Disabled by default.',
    build: async () => buildPreEventEmailGraph(),
  },
];

let booted = false;

function parseSeedConfig(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

async function writeGraph(trx, workflowId, version, nodes, edges) {
  for (const n of nodes) {
    await trx('workflow_nodes').insert({
      workflow_id: workflowId, version, node_key: n.node_key, type: n.type,
      config: JSON.stringify(n.config || {}), pos_x: n.pos_x || 0, pos_y: n.pos_y || 0,
    });
  }
  for (const e of edges) {
    await trx('workflow_edges').insert({
      workflow_id: workflowId, version, from_node: e.from_node, from_handle: e.from_handle || null,
      to_node: e.to_node, label: e.label || null, loop_back: !!e.loop_back,
    });
  }
}

async function seedOneBuiltin(db, logger, def) {
  const { nodes, edges } = await def.build();
  const triggerConfig = { ...(def.trigger_config || {}), seedVersion: def.version };

  const existing = await db('workflows').where({ builtin_key: def.key }).first();

  if (existing) {
    // Re-seed the graph only when (a) it has never been activated and (b) our
    // seed version moved on. Once the admin enables it, it's their live flow —
    // never overwrite it.
    const storedVersion = Number(parseSeedConfig(existing.trigger_config).seedVersion) || 0;
    const isEnabled = existing.enabled === true || existing.enabled === 1;
    if (isEnabled || storedVersion >= def.version) return;

    const newVersion = (existing.version || 1) + 1;
    await db.transaction(async (trx) => {
      await trx('workflows').where({ id: existing.id }).update({
        name: def.name,
        description: def.description,
        trigger_type: def.trigger_type,
        trigger_config: JSON.stringify(triggerConfig),
        version: newVersion,
        updated_at: trx.fn.now(),
      });
      await writeGraph(trx, existing.id, newVersion, nodes, edges);
    });
    logger?.info?.(`Re-seeded built-in workflow: ${def.key} (v${def.version})`);
    return;
  }

  await db.transaction(async (trx) => {
    const ins = await trx('workflows').insert({
      name: def.name,
      description: def.description,
      enabled: false,
      version: 1,
      trigger_type: def.trigger_type,
      trigger_config: JSON.stringify(triggerConfig),
      is_builtin: true,
      builtin_key: def.key,
    }).returning('id');
    // Postgres returns [] without `.returning`, so ins[0] would be undefined and
    // the child node inserts would roll back on NOT NULL. Normalise the {id}
    // (pg) vs bare-id (sqlite) shapes.
    const workflowId = ins[0]?.id ?? ins[0];
    await writeGraph(trx, workflowId, 1, nodes, edges);
  });
  logger?.info?.(`Seeded built-in workflow: ${def.key} (disabled)`);
}

async function seedBuiltinWorkflowsAtBoot(db, logger) {
  try {
    if (!(await db.schema.hasTable('workflows'))) return;
    for (const def of BUILTINS) {
      try {
        await seedOneBuiltin(db, logger, def);
      } catch (err) {
        logger?.warn?.(`Built-in workflow seed failed for ${def.key}:`, err.message);
      }
    }
    booted = true;
  } catch (err) {
    logger?.warn?.('Built-in workflow seed failed at boot:', err.message);
  }
}

module.exports = { seedBuiltinWorkflowsAtBoot, buildDunningGraph, DUNNING_KEY, BUILTINS };

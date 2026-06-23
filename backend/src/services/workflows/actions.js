/**
 * Workflow action + condition handlers that touch real picpeak data.
 *
 * Registered at load time (index.js requires this module). Kept separate from
 * registry.js (which holds only primitives) so the I/O-coupled handlers don't
 * bloat the pure core.
 *
 * Email routing rule (locked requirement): INTERNAL/admin mail sends
 * immediately; EXTERNAL/customer mail respects the business-hours floor. The
 * action sets queueEmail's `respectBusinessHours` from the recipient class.
 *
 * The create/prepare-document actions (quote/contract/event/gallery/invoice)
 * are registered so flows validate, but are intentionally NOT wired to the
 * services yet — they record a `skipped` step with a clear reason so the gap
 * is observable rather than silent. Wiring is a follow-up commit.
 */
const registry = require('./registry');

const DOCUMENT_ACTIONS = [
  'prepare_quote',
  'prepare_contract',
  'prepare_event',
  'prepare_gallery',
  'prepare_invoice',
  'send_document',
  'reserve_date',
];

// --- Conditions ---

// True once the run's invoice entity is settled (paid_at set, status paid, or
// the cumulative paid amount covers the total).
registry.registerCondition('invoice_paid', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return false;
  const inv = await ctx.db('invoices').where({ id }).first();
  if (!inv) return false;
  if (inv.paid_at) return true;
  if (inv.status === 'paid') return true;
  const paid = Number(inv.paid_amount_minor) || 0;
  const total = Number(inv.total_amount_minor);
  return Number.isFinite(total) && total > 0 && paid >= total;
});

// --- Actions ---

// Queue an email. recipientClass 'admin' (internal) sends immediately;
// anything else (customer/external) respects the business-hours floor.
registry.registerAction('send_email', async (ctx) => {
  const cfg = ctx.node.config || {};
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'send_email', recipientClass: cfg.recipientClass || cfg.recipient || 'customer', emailType: cfg.emailType || cfg.template };
  const recipientClass = cfg.recipientClass || cfg.recipient || 'customer';
  const isInternal = recipientClass === 'admin' || recipientClass === 'internal';
  const to = cfg.to
    || ctx.vars[isInternal ? 'adminEmail' : 'customerEmail']
    || ctx.vars.recipientEmail;
  if (!to) return { skipped: true, reason: 'no recipient resolved' };

  const emailProcessor = require('../emailProcessor');
  const eventId = ctx.vars.eventId || null;
  const emailType = cfg.emailType || cfg.template || 'workflow_notification';
  const emailData = { ...(cfg.emailData || {}), ...(ctx.vars.emailData || {}) };

  // INTERNAL/admin = immediate; EXTERNAL/customer = business-hours floor.
  const respectBusinessHours = !isInternal;
  await emailProcessor.queueEmail(eventId, to, emailType, emailData, { respectBusinessHours });
  return { sent_to: to, recipientClass, respectBusinessHours };
});

// Fire the existing admin payment-check email (the dunning gate). Delegates to
// invoiceService.queuePaymentCheckEmail so the proven escalation +
// Mahngebühr / reminder_level state machine (recordPaymentCheckAction) stays
// the single source of truth — the workflow only decides WHEN it fires. This
// is what makes the built-in dunning flow a faithful replacement for the
// hardcoded ladder (paired with the mutual-exclusion guard in runScheduledTasks).
registry.registerAction('queue_payment_check', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no invoice entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'queue_payment_check', invoiceId: id };
  await require('../invoiceService').queuePaymentCheckEmail(id);
  return { payment_check_queued: id };
});

// After the dunning loop exhausts (e.g. 3 unpaid reminders), consolidate
// everything collections needs into ONE email to the admin: customer data, the
// outstanding total (invoice + late fees − paid) and the invoice PDF attached —
// ready to forward to an Inkasso agency / for Betreibung. Internal mail → sent
// immediately. Does NOT touch the invoice.
registry.registerAction('escalate_to_collections', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no invoice entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'escalate_to_collections', invoiceId: id };
  const { db } = ctx;
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) return { skipped: true, reason: 'invoice not found' };
  const customer = invoice.customer_account_id
    ? await db('customer_accounts').where({ id: invoice.customer_account_id }).first()
    : null;
  const profile = await db('business_profile').where({ id: 1 }).first();
  const adminEmail = ctx.vars?.adminEmail || profile?.email || null;
  if (!adminEmail) return { skipped: true, reason: 'no admin email' };

  const currency = invoice.currency || 'CHF';
  const fmt = (m) => `${currency} ${(Number(m || 0) / 100).toFixed(2)}`;
  const total = Number(invoice.total_amount_minor || 0);
  const fee = Number(invoice.late_fee_amount_minor || 0);
  const paid = Number(invoice.paid_amount_minor || 0);
  const outstanding = Math.max(0, total + fee - paid);
  const address = [customer?.address, customer?.postal_code, customer?.city, customer?.country_name]
    .filter(Boolean).join(', ');

  const attachments = [];
  try {
    const fs = require('fs');
    if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
      attachments.push({ filename: `${invoice.invoice_number}.pdf`, contentPath: invoice.pdf_path, contentType: 'application/pdf' });
    }
  } catch (_) { /* attachment is best-effort */ }

  await require('../emailProcessor').queueEmail(invoice.event_id || null, adminEmail, 'invoice_collections_handoff', {
    invoice_number: invoice.invoice_number,
    customer_name: customer?.display_name || customer?.email || '—',
    customer_email: customer?.email || '',
    customer_address: address,
    event_name: invoice.event_name || '',
    original_amount: fmt(total),
    late_fee_amount: fee ? fmt(fee) : '',
    paid_amount: fmt(paid),
    outstanding_amount: fmt(outstanding),
    due_date: invoice.due_date ? String(invoice.due_date).slice(0, 10) : '',
    reminder_level: invoice.reminder_level || 0,
    attachments,
  }, { respectBusinessHours: false }); // internal/admin → immediate

  return { collections_handoff_to: adminEmail, outstanding };
});

// --- Gallery / pre-event notification actions (cutover) ---
//
// These DELEGATE to the existing service send functions, so the engine path is
// byte-identical to the legacy hourly checker/pass it replaces (same templates,
// recipients, variables, dedup). The legacy path stands down when the matching
// built-in flow is enabled (isBuiltinFlowActive guard), so exactly one email
// goes out.

// Send the gallery expiration-warning email for the run's event entity.
registry.registerAction('notify_gallery_expiring', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no event entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'notify_gallery_expiring', eventId: id };
  const event = await ctx.db('events').where({ id }).first();
  if (!event) return { skipped: true, reason: 'event not found' };
  await require('../expirationChecker').queueExpirationWarning(event);
  return { warning_queued: id };
});

// Send the gallery_expired email(s) for the run's event entity.
registry.registerAction('notify_gallery_expired', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no event entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'notify_gallery_expired', eventId: id };
  const event = await ctx.db('events').where({ id }).first();
  if (!event) return { skipped: true, reason: 'event not found' };
  await require('../expirationChecker').sendGalleryExpiredEmails(event);
  return { expired_email_queued: id };
});

// Send the pre-event customer reminder for the run's event entity. Delegates to
// eventReminderService so per-event overrides + sent_at idempotency are honoured.
registry.registerAction('notify_pre_event', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no event entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'notify_pre_event', eventId: id };
  const res = await require('../eventReminderService').sendReminderForEvent(id);
  return res;
});

// Create/prepare-document actions — registered so flows referencing them are
// valid; service wiring is a follow-up. Records a skipped step (observable).
for (const key of DOCUMENT_ACTIONS) {
  registry.registerAction(key, async (ctx) => {
    ctx.logger?.warn?.('[workflow] document action not yet wired', { action: key, runId: ctx.run.id });
    return { skipped: true, reason: `action ${key} not yet implemented` };
  });
}

module.exports = { DOCUMENT_ACTIONS };

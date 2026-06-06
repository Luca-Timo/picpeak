/**
 * projectService — the admin-only "Project Overview" grouping layer (Model A).
 *
 * A project groups 1..N events. Money documents stay attached to their EVENT
 * (or, for quotes/contracts which carry no event_id, to the CUSTOMER) and the
 * project rolls them up for the cockpit. Customers never see projects.
 *
 * Rollup scoping (v1):
 *   - invoices / emails / galleries → by the project's EVENTS (event_id).
 *   - hours                         → by customer_hour_entries.project_id.
 *   - quotes / contracts            → by the project's customer_account_id
 *     (they have no event_id; see migration 107). Empty when the project has
 *     no single customer set.
 */

const { db } = require('../database/db');
const { AppError } = require('../utils/errors');

function transformProject(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    customerAccountId: p.customer_account_id || null,
    customerEmail: p.customer_email || null,
    status: p.status,
    eventCount: p.event_count != null ? Number(p.event_count) : undefined,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** List projects with customer email + event count. */
async function listProjects({ search = '', status = null } = {}) {
  let q = db('projects')
    .leftJoin('customer_accounts', 'customer_accounts.id', 'projects.customer_account_id')
    .select(
      'projects.*',
      'customer_accounts.email as customer_email',
      db('events').count('* as c').whereRaw('events.project_id = projects.id').as('event_count'),
    )
    .orderBy('projects.updated_at', 'desc');
  if (status) q = q.where('projects.status', status);
  if (search) {
    q = q.where(function () {
      this.where('projects.name', 'like', `%${search}%`)
        .orWhere('customer_accounts.email', 'like', `%${search}%`);
    });
  }
  const rows = await q;
  return rows.map(transformProject);
}

async function getProjectById(id) {
  const row = await db('projects')
    .leftJoin('customer_accounts', 'customer_accounts.id', 'projects.customer_account_id')
    .select('projects.*', 'customer_accounts.email as customer_email')
    .where('projects.id', id)
    .first();
  return transformProject(row);
}

async function createProject({ name, customerAccountId = null }, adminId) {
  if (!name || !String(name).trim()) throw new AppError('Project name is required', 400);
  const inserted = await db('projects').insert({
    name: String(name).trim(),
    customer_account_id: customerAccountId || null,
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id');
  const id = (inserted[0] && typeof inserted[0] === 'object') ? inserted[0].id : inserted[0];
  return getProjectById(id);
}

async function updateProject(id, { name, customerAccountId, status }) {
  const existing = await db('projects').where({ id }).first();
  if (!existing) throw new AppError('Project not found', 404);
  const patch = { updated_at: new Date() };
  if (name !== undefined) patch.name = String(name).trim();
  if (customerAccountId !== undefined) patch.customer_account_id = customerAccountId || null;
  if (status !== undefined) patch.status = status;
  await db('projects').where({ id }).update(patch);
  return getProjectById(id);
}

/** Attach an event to a project (re-points events.project_id). */
async function assignEvent(projectId, eventId) {
  const project = await db('projects').where({ id: projectId }).first();
  if (!project) throw new AppError('Project not found', 404);
  const event = await db('events').where({ id: eventId }).first();
  if (!event) throw new AppError('Event not found', 404);
  await db('events').where({ id: eventId }).update({ project_id: projectId });
  return { projectId, eventId };
}

/**
 * Full overview aggregation for the cockpit. Returns the project, its events,
 * and the rolled-up emails / quotes / contracts / invoices / hours + a
 * timeline of milestones. `perms` gates which doc types are included.
 */
async function getProjectOverview(id, perms = {}) {
  const project = await getProjectById(id);
  if (!project) throw new AppError('Project not found', 404);

  const events = await db('events')
    .where({ project_id: id })
    .select('id', 'event_name', 'event_date', 'slug', 'is_active', 'is_draft', 'expires_at', 'is_archived');
  const eventIds = events.map((e) => e.id);

  const out = { project, events, emails: [], quotes: [], contracts: [], invoices: [], hours: { entries: [], totalMinutes: 0 } };

  // Emails (by event) — newest first. rendered_html presence flagged, body
  // itself fetched lazily by the preview endpoint.
  if (eventIds.length) {
    const emails = await db('email_queue')
      .whereIn('event_id', eventIds)
      .select('id', 'recipient_email', 'email_type', 'status', 'created_at', 'sent_at', 'error_message', 'event_id')
      .orderBy('created_at', 'desc')
      .limit(200);
    out.emails = emails.map((e) => ({
      id: e.id, recipient: e.recipient_email, type: e.email_type, status: e.status,
      queuedAt: e.created_at, sentAt: e.sent_at, error: e.error_message, eventId: e.event_id,
    }));
  }

  // Invoices (by event) incl. storno.
  if (eventIds.length && perms.bills !== false) {
    out.invoices = await db('invoices')
      .whereIn('event_id', eventIds)
      .select('id', 'invoice_number', 'status', 'kind', 'issue_date', 'due_date',
        'total_amount_minor', 'paid_amount_minor', 'paid_at', 'currency', 'event_id', 'deal_uuid')
      .orderBy('issue_date', 'desc');
  }

  // Quotes / contracts (by customer — no event_id on those tables).
  if (project.customerAccountId) {
    if (perms.quotes !== false) {
      out.quotes = await db('quotes')
        .where({ customer_account_id: project.customerAccountId })
        .select('id', 'quote_number', 'status', 'issue_date', 'valid_until', 'total_amount_minor', 'currency', 'deal_uuid')
        .orderBy('issue_date', 'desc');
    }
    if (perms.contracts !== false) {
      out.contracts = await db('contracts')
        .where({ customer_account_id: project.customerAccountId })
        .select('id', 'contract_number', 'status', 'issue_date', 'signed_by_customer_at', 'deal_uuid')
        .orderBy('issue_date', 'desc');
    }
  }

  // Hours (by project_id) — individual entries + total.
  const hours = await db('customer_hour_entries')
    .where({ project_id: id })
    .select('id', 'entry_date', 'duration_minutes', 'description', 'status', 'invoice_id')
    .orderBy('entry_date', 'desc');
  out.hours = {
    entries: hours,
    totalMinutes: hours.reduce((s, h) => s + Number(h.duration_minutes || 0), 0),
  };

  // Timeline milestones (latest of each kind that exists), each dated.
  const milestones = [];
  const firstQuote = out.quotes[out.quotes.length - 1];
  if (firstQuote) milestones.push({ kind: 'quote', label: firstQuote.quote_number, date: firstQuote.issue_date });
  const firstContract = out.contracts[out.contracts.length - 1];
  if (firstContract) milestones.push({ kind: 'contract', label: firstContract.contract_number, date: firstContract.issue_date });
  const pubEvent = events.find((e) => e.is_active && !e.is_draft);
  if (pubEvent) milestones.push({ kind: 'gallery', label: pubEvent.event_name, date: pubEvent.event_date });
  const firstInvoice = out.invoices[out.invoices.length - 1];
  if (firstInvoice) milestones.push({ kind: 'invoice', label: firstInvoice.invoice_number, date: firstInvoice.issue_date });
  out.milestones = milestones;

  return out;
}

/**
 * The ACTUAL sent HTML for an email_queue row (cockpit preview). Rows sent
 * before the rendered_html column existed have none → `available:false`, the
 * frontend then shows a "preview not stored" note rather than a stale
 * re-render.
 */
async function getEmailPreview(emailId) {
  const row = await db('email_queue')
    .where({ id: emailId })
    .select('id', 'recipient_email', 'email_type', 'status', 'rendered_html')
    .first();
  if (!row) throw new AppError('Email not found', 404);
  return {
    id: row.id,
    recipient: row.recipient_email,
    type: row.email_type,
    status: row.status,
    available: !!row.rendered_html,
    html: row.rendered_html || null,
  };
}

module.exports = {
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  assignEvent,
  getProjectOverview,
  getEmailPreview,
};

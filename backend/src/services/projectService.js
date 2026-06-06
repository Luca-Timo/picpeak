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
const { hasColumnCached } = require('../utils/schemaCache');

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

/** List projects with customer email + event count + rolled-up value.
 *  `perms` gates which document types feed the value (matches the cockpit):
 *  invoices need bills.view, quotes need quotes.view. */
async function listProjects({ search = '', status = null, perms = {} } = {}) {
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
  const projects = rows.map(transformProject);
  await attachValuations(projects, perms);
  return projects;
}

/**
 * Compute + attach `valuation` to each listed project in two bulk queries
 * (not per-project), then run the shared newest-wins-per-deal helper. Mutates
 * the passed array. Documents the admin can't see (per perms) are excluded,
 * so the value never leaks figures the admin lacks permission for.
 */
async function attachValuations(projects, perms = {}) {
  if (!projects.length) return;
  const projectIds = projects.map((p) => p.id);

  // Invoices roll up by event → project_id; quotes by quotes.project_id.
  let invoices = [];
  if (perms.bills !== false) {
    invoices = await db('invoices as inv')
      .join('events as e', 'e.id', 'inv.event_id')
      .whereIn('e.project_id', projectIds)
      .select('e.project_id as project_id', 'inv.id', 'inv.deal_uuid',
        'inv.total_amount_minor', 'inv.paid_amount_minor', 'inv.currency');
  }
  let quotes = [];
  if (perms.quotes !== false && await hasColumnCached('quotes', 'project_id')) {
    quotes = await db('quotes')
      .whereIn('project_id', projectIds)
      .select('project_id', 'id', 'deal_uuid', 'total_amount_minor', 'currency', 'issue_date');
  }

  const invByProject = new Map();
  for (const inv of invoices) {
    const list = invByProject.get(inv.project_id) || [];
    list.push(inv); invByProject.set(inv.project_id, list);
  }
  const quoteByProject = new Map();
  for (const qt of quotes) {
    const list = quoteByProject.get(qt.project_id) || [];
    list.push(qt); quoteByProject.set(qt.project_id, list);
  }
  for (const p of projects) {
    p.valuation = computeValuation(invByProject.get(p.id) || [], quoteByProject.get(p.id) || []);
  }
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

/** Attach (or, with projectId=null, detach) a quote/contract to a project. */
async function assignDocument(table, projectId, documentId) {
  if (!(await hasColumnCached(table, 'project_id'))) {
    throw new AppError('This instance has no project_id column yet — run migrations', 409);
  }
  if (projectId != null) {
    const project = await db('projects').where({ id: projectId }).first();
    if (!project) throw new AppError('Project not found', 404);
  }
  const doc = await db(table).where({ id: documentId }).first();
  if (!doc) throw new AppError('Document not found', 404);
  await db(table).where({ id: documentId }).update({ project_id: projectId || null });
  return { projectId: projectId || null, documentId };
}

const assignQuote = (projectId, quoteId) => assignDocument('quotes', projectId, quoteId);
const assignContract = (projectId, contractId) => assignDocument('contracts', projectId, contractId);

/**
 * Project valuation — "newest stage wins per deal, cumulative across events".
 *
 * Each deal (deal_uuid lineage: quote → contract → invoice) contributes ONE
 * figure: the invoice total when the deal has reached invoicing (installments
 * summed; storno rows net out a cancelled invoice via their negative totals),
 * otherwise the newest quote's total. Contracts carry no monetary total in
 * picpeak, so they never contribute a number — the "newest" of the three is
 * therefore always the invoice when present, else the quote. Documents with
 * no deal_uuid each count as their own standalone deal. Totals are kept per
 * currency so a mixed-currency project stays correct.
 *
 * @param {Array} invoices  rows with deal_uuid, total_amount_minor, paid_amount_minor, currency
 * @param {Array} quotes    rows with deal_uuid, total_amount_minor, currency, issue_date
 * @returns {{ byCurrency: Array<{currency:string,totalMinor:number,paidMinor:number}> }}
 */
function computeValuation(invoices = [], quotes = []) {
  const deals = new Map();
  const get = (key, currency) => {
    let d = deals.get(key);
    if (!d) { d = { currency, invoiceMinor: 0, paidMinor: 0, hasInvoice: false, quoteMinor: 0, quoteDate: null }; deals.set(key, d); }
    return d;
  };
  for (const inv of invoices) {
    const d = get(inv.deal_uuid || `i-${inv.id}`, inv.currency || 'CHF');
    d.hasInvoice = true;
    d.invoiceMinor += Number(inv.total_amount_minor || 0);
    d.paidMinor += Number(inv.paid_amount_minor || 0);
    d.currency = inv.currency || d.currency;
  }
  for (const q of quotes) {
    const d = get(q.deal_uuid || `q-${q.id}`, q.currency || 'CHF');
    const qd = q.issue_date ? new Date(q.issue_date).getTime() : 0;
    if (d.quoteDate === null || qd >= d.quoteDate) {
      d.quoteMinor = Number(q.total_amount_minor || 0);
      d.quoteDate = qd;
      if (!d.hasInvoice) d.currency = q.currency || d.currency;
    }
  }
  const byCurrency = new Map();
  for (const d of deals.values()) {
    const value = d.hasInvoice ? d.invoiceMinor : d.quoteMinor;
    const cur = d.currency || 'CHF';
    const b = byCurrency.get(cur) || { totalMinor: 0, paidMinor: 0 };
    b.totalMinor += value;
    b.paidMinor += d.paidMinor;
    byCurrency.set(cur, b);
  }
  return {
    byCurrency: Array.from(byCurrency.entries()).map(([currency, v]) => ({
      currency, totalMinor: v.totalMinor, paidMinor: v.paidMinor,
    })),
  };
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

  // Quotes / contracts. These tables carry no event_id (migration 107), so
  // they're linked to the project explicitly via project_id (migration 121).
  // Where that column doesn't exist yet (pre-121 DB) we fall back to the
  // project's customer — the original, less precise scoping.
  const quotesHaveProjectId = await hasColumnCached('quotes', 'project_id');
  const contractsHaveProjectId = await hasColumnCached('contracts', 'project_id');

  if (perms.quotes !== false && (quotesHaveProjectId || project.customerAccountId)) {
    let q = db('quotes')
      .select('id', 'quote_number', 'status', 'issue_date', 'valid_until', 'total_amount_minor', 'currency', 'deal_uuid')
      .orderBy('issue_date', 'desc');
    if (quotesHaveProjectId) q = q.where({ project_id: id });
    else q = q.where({ customer_account_id: project.customerAccountId });
    out.quotes = await q;
  }
  if (perms.contracts !== false && (contractsHaveProjectId || project.customerAccountId)) {
    let q = db('contracts')
      .select('id', 'contract_number', 'status', 'issue_date', 'signed_by_customer_at', 'deal_uuid')
      .orderBy('issue_date', 'desc');
    if (contractsHaveProjectId) q = q.where({ project_id: id });
    else q = q.where({ customer_account_id: project.customerAccountId });
    out.contracts = await q;
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

  // Rolled-up project value (newest stage wins per deal, cumulative).
  out.valuation = computeValuation(out.invoices, out.quotes);

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

// ── Email actions (from the cockpit feed) ───────────────────────────────

async function resendEmail(emailId) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  const insert = await db('email_queue').insert({
    recipient_email: row.recipient_email,
    email_type: row.email_type,
    email_data: row.email_data,
    event_id: row.event_id,
    status: 'pending',
    retry_count: 0,
    created_at: new Date(),
  }).returning('id');
  const id = (insert[0] && typeof insert[0] === 'object') ? insert[0].id : insert[0];
  return { id, status: 'pending' };
}

async function cancelEmail(emailId) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  if (row.status !== 'pending') throw new AppError('Only pending emails can be cancelled', 409);
  await db('email_queue').where({ id: emailId }).update({ status: 'cancelled' });
  return { id: emailId, status: 'cancelled' };
}

async function retryEmail(emailId) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  await db('email_queue').where({ id: emailId })
    .update({ status: 'pending', retry_count: 0, error_message: null, scheduled_at: null });
  return { id: emailId, status: 'pending' };
}

async function sendEmailNow(emailId) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  await db('email_queue').where({ id: emailId }).update({ status: 'pending', scheduled_at: null });
  const { processEmailQueue } = require('./emailProcessor');
  return processEmailQueue({ ignoreSchedule: true, limit: 50 });
}

module.exports = {
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  assignEvent,
  assignQuote,
  assignContract,
  computeValuation,
  getProjectOverview,
  getEmailPreview,
  resendEmail,
  cancelEmail,
  retryEmail,
  sendEmailNow,
};

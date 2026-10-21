/**
 * Project-first flow ("Neue Anfrage", migration 315).
 *
 * A project is created as an inquiry with the data it started from, edited in
 * place, moves to `active` once something is attached, derives its stage from
 * what it holds, and rolls up invoices through its own project_id or its deal
 * as well as through its galleries. Deleting it keeps every document and only
 * clears the link.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-projflow-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'projflow-test-secret';

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('project inquiry flow', () => {
  let db; let cleanup; let app;
  let superToken; let superId; let editorToken; let editorId; let customerId; let otherCustomerId;
  let seq = 0;

  const idOf = (r) => r[0]?.id ?? r[0];

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const id = idOf(await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id'));
    return {
      id,
      token: jwt.sign(
        { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
        process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
      ),
    };
  };

  const mkEvent = async ({ projectId = null, published = true } = {}) => {
    seq += 1;
    return idOf(await db('events').insert({
      slug: `flow-ev-${seq}`, event_type: 'wedding', event_name: `Flow ${seq}`, event_date: '2027-06-12',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: `flow-tok-${seq}`, share_link: `/gallery/flow-ev-${seq}/flow-tok-${seq}`,
      created_by: superId, project_id: projectId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: published ? 0 : 1,
      created_at: new Date().toISOString(),
    }).returning('id'));
  };

  const mkQuote = async ({ projectId = null, status = 'accepted', dealUuid }) => {
    seq += 1;
    return idOf(await db('quotes').insert({
      quote_number: `Q-FLOW-${seq}`, customer_account_id: customerId, deal_uuid: dealUuid,
      project_id: projectId, status, currency: 'CHF', issue_date: '2027-02-09',
      total_amount_minor: 450000,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
  };

  const mkInvoice = async ({ projectId = null, dealUuid = null, status = 'sent', eventId = null, total = 135000 }) => {
    seq += 1;
    return idOf(await db('invoices').insert({
      invoice_number: `R-FLOW-${seq}`, customer_account_id: customerId, deal_uuid: dealUuid,
      project_id: projectId, event_id: eventId, status, currency: 'CHF',
      issue_date: '2027-02-20', due_date: '2027-03-20',
      total_amount_minor: total,
      paid_amount_minor: status === 'paid' ? total : 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
  };

  const post = (url, body, token = superToken) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body);
  const put = (url, body, token = superToken) => request(app).put(url).set('Authorization', `Bearer ${token}`).send(body);
  const get = (url, token = superToken) => request(app).get(url).set('Authorization', `Bearer ${token}`);

  const createInquiry = async (extra = {}) => {
    const res = await post('/api/admin/projects', {
      name: 'Hochzeit Keller & Brunner',
      customerAccountId: customerId,
      status: 'inquiry',
      eventType: 'wedding',
      eventDate: '2027-06-12',
      location: 'Schloss Vaduz',
      guestCount: 120,
      budgetMinor: 450000,
      currency: 'chf',
      source: 'referral',
      notes: 'Trauung 14 Uhr',
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.data?.project || res.body.project;
  };

  const overview = async (id) => {
    const res = await get(`/api/admin/projects/${id}/overview`);
    expect(res.status).toBe(200);
    return res.body.data || res.body;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    otherCustomerId = idOf(await db('customer_accounts').insert({
      email: 'other@example.com', display_name: 'Other', is_active: 1, created_at: new Date(),
    }).returning('id'));
    for (const key of ['projects', 'bills']) {
      await db('feature_flags').insert({ key, value: 1 }).onConflict('key').merge({ value: 1 });
    }

    const sup = await mkAdmin('flow-super', 'super_admin');
    superToken = sup.token; superId = sup.id;
    const editor = await mkAdmin('flow-editor', 'editor');
    editorToken = editor.token; editorId = editor.id;

    app = express();
    app.use(express.json());
    app.use('/api/admin/projects', require('../../src/routes/adminProjects'));
    app.use('/api/admin/invoices', require('../../src/routes/adminInvoices'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('creates an inquiry with its data, dates as YYYY-MM-DD and the currency upper-cased', async () => {
    const project = await createInquiry();
    expect(project).toMatchObject({
      status: 'inquiry', eventType: 'wedding', eventDate: '2027-06-12', eventEndDate: null,
      location: 'Schloss Vaduz', guestCount: 120, budgetMinor: 450000, currency: 'CHF',
      source: 'referral', notes: 'Trauung 14 Uhr',
    });
  });

  it.each([
    ['an end date before the start date', { eventDate: '2027-06-12', eventEndDate: '2027-06-11' }],
    ['an unknown source', { source: 'billboard' }],
    ['an unknown status', { status: 'lost' }],
    ['a negative guest count', { guestCount: -1 }],
    ['a date that is not a date', { eventDate: '12.06.2027' }],
  ])('refuses %s', async (_label, extra) => {
    const res = await post('/api/admin/projects', { name: 'Bad', ...extra });
    expect(res.status).toBe(400);
  });

  it('refuses an end date before the stored start date when only the end date changes', async () => {
    const project = await createInquiry();
    const res = await put(`/api/admin/projects/${project.id}`, { eventEndDate: '2027-06-01' });
    expect(res.status).toBe(400);
  });

  it('edits fields in place and clears them with null, leaving the rest alone', async () => {
    const project = await createInquiry();
    const res = await put(`/api/admin/projects/${project.id}`, { guestCount: 140, location: null });
    expect(res.status).toBe(200);
    const updated = res.body.data?.project || res.body.project;
    expect(updated).toMatchObject({ guestCount: 140, location: null, eventDate: '2027-06-12', notes: 'Trauung 14 Uhr' });
  });

  it('becomes active once a gallery is attached', async () => {
    const project = await createInquiry();
    const eventId = await mkEvent();
    const res = await post(`/api/admin/projects/${project.id}/events`, { eventId });
    expect(res.status).toBe(200);
    const row = await db('projects').where({ id: project.id }).first('status');
    expect(row.status).toBe('active');
  });

  it('leaves a cancelled project cancelled when something is attached', async () => {
    const project = await createInquiry({ status: 'cancelled' });
    const eventId = await mkEvent();
    await post(`/api/admin/projects/${project.id}/events`, { eventId });
    const row = await db('projects').where({ id: project.id }).first('status');
    expect(row.status).toBe('cancelled');
  });

  it('starts at the quote stage', async () => {
    const project = await createInquiry();
    const { stage } = await overview(project.id);
    expect(stage.current).toBe('quote');
    expect(stage.stages.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo', 'todo']);
  });

  it('derives stages from documents and marks the ones jumped over as skipped', async () => {
    const project = await createInquiry();
    await mkQuote({ projectId: project.id, dealUuid: crypto.randomUUID() });
    await mkEvent({ projectId: project.id });
    const { stage } = await overview(project.id);
    // Quote accepted, no contract, gallery published, no invoice yet.
    expect(stage.stages.map((s) => [s.key, s.state])).toEqual([
      ['inquiry', 'done'], ['quote', 'done'], ['contract', 'skipped'],
      ['gallery', 'done'], ['invoice', 'current'], ['done', 'todo'],
    ]);
  });

  it('reports no current stage on a cancelled project', async () => {
    const project = await createInquiry({ status: 'cancelled' });
    const { stage } = await overview(project.id);
    expect(stage.current).toBeNull();
  });

  it('rolls up invoices by their own project_id and by the deal of a linked quote', async () => {
    const project = await createInquiry();
    const deal = crypto.randomUUID();
    await mkQuote({ projectId: project.id, dealUuid: deal });
    const own = await mkInvoice({ projectId: project.id, status: 'paid' });
    const viaDeal = await mkInvoice({ dealUuid: deal });
    const unrelated = await mkInvoice({ dealUuid: crypto.randomUUID() });

    const { invoices, valuation } = await overview(project.id);
    const ids = invoices.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([own, viaDeal]));
    expect(ids).not.toContain(unrelated);
    // Newest stage wins per deal: the deal's invoice replaces its quote.
    expect(valuation.byCurrency).toEqual([{ currency: 'CHF', totalMinor: 270000, paidMinor: 135000 }]);
  });

  it('lists projects by several statuses with their stage for the dashboard', async () => {
    const res = await get('/api/admin/projects?status=inquiry,cancelled&withStages=1');
    expect(res.status).toBe(200);
    const projects = res.body.data?.projects || res.body.projects;
    expect(projects.length).toBeGreaterThan(0);
    expect(new Set(projects.map((p) => p.status))).toEqual(new Set(['inquiry', 'cancelled']));
    for (const p of projects) expect(p.stage.stages).toHaveLength(6);
  });

  it('creates an invoice in the project and refuses one for another customer or a foreign project', async () => {
    const project = await createInquiry();
    const body = {
      customerAccountId: customerId,
      projectId: project.id,
      currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 135000 }],
    };
    const ok = await post('/api/admin/invoices', body);
    expect(ok.status).toBe(201);
    const invoiceId = (ok.body.data || ok.body).invoiceIds[0];
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBe(project.id);
    expect((await db('projects').where({ id: project.id }).first('status')).status).toBe('active');

    const mismatch = await post('/api/admin/invoices', { ...body, customerAccountId: otherCustomerId });
    expect(mismatch.status).toBe(422);

    // An editor does not own the super admin's project: 404, not 403.
    const foreign = await post('/api/admin/invoices', body, editorToken);
    expect([403, 404]).toContain(foreign.status);
    if (foreign.status === 404) expect(foreign.body.error).toBe('Project not found');
  });

  it('deletes a project and keeps its gallery, quote and invoice, only unlinked', async () => {
    const project = await createInquiry();
    const deal = crypto.randomUUID();
    const quoteId = await mkQuote({ projectId: project.id, dealUuid: deal });
    const eventId = await mkEvent({ projectId: project.id });
    const invoiceId = await mkInvoice({ projectId: project.id });

    const res = await request(app).delete(`/api/admin/projects/${project.id}`).set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(await db('projects').where({ id: project.id }).first()).toBeUndefined();
    expect((await db('quotes').where({ id: quoteId }).first('project_id')).project_id).toBeNull();
    expect((await db('events').where({ id: eventId }).first('project_id')).project_id).toBeNull();
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBeNull();
  });

  it('keeps a gallery done once published, even after it expired', async () => {
    const project = await createInquiry();
    const eventId = await mkEvent({ projectId: project.id });
    await db('events').where({ id: eventId }).update({ is_active: 0 });
    const { stage } = await overview(project.id);
    expect(stage.stages.find((x) => x.key === 'gallery').state).toBe('done');
  });

  it('rolls up the Storno and the reissue of a project invoice', async () => {
    const project = await createInquiry();
    const original = await mkInvoice({ projectId: project.id, status: 'cancelled' });
    const storno = await mkInvoice({ status: 'sent', total: -135000 });
    await db('invoices').where({ id: storno }).update({ kind: 'storno', cancels_invoice_id: original });
    const reissue = await mkInvoice({ status: 'sent' });
    await db('invoices').where({ id: reissue }).update({ replaces_invoice_id: original });
    const { invoices } = await overview(project.id);
    expect(invoices.map((i) => i.id)).toEqual(expect.arrayContaining([original, storno, reissue]));
  });

  it('refuses an invoice in the project for a customer billed monthly, rather than dropping the link', async () => {
    const monthly = idOf(await db('customer_accounts').insert({
      email: 'monthly@example.com', display_name: 'Monthly', is_active: 1, billing_cadence: 'monthly', created_at: new Date(),
    }).returning('id'));
    const project = await createInquiry({ customerAccountId: monthly });
    const res = await post('/api/admin/invoices', {
      customerAccountId: monthly, projectId: project.id, currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_INVOICE_COLLECTED_BILLING');
    expect((await db('projects').where({ id: project.id }).first('status')).status).toBe('inquiry');
  });

  it('lets a project without a customer adopt the customer of its first invoice', async () => {
    const project = await createInquiry({ customerAccountId: null });
    const res = await post('/api/admin/invoices', {
      customerAccountId: customerId, projectId: project.id, currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBe(201);
    expect((await db('projects').where({ id: project.id }).first('customer_account_id')).customer_account_id).toBe(customerId);
  });

  it('refuses to delete a project that holds another admin\'s gallery', async () => {
    const own = idOf(await db('projects').insert({
      name: 'Editor project', status: 'active', created_by: editorId, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const foreignEvent = await mkEvent({ projectId: own });
    const res = await request(app).delete(`/api/admin/projects/${own}`).set('Authorization', `Bearer ${editorToken}`);
    expect(res.status).toBe(403);
    expect((await db('events').where({ id: foreignEvent }).first('project_id')).project_id).toBe(own);
  });

  it('answers 403 on every project route with the feature off', async () => {
    await db('feature_flags').where({ key: 'projects' }).update({ value: 0 });
    try {
      const res = await post('/api/admin/projects', { name: 'Off', status: 'inquiry' });
      expect(res.status).toBe(403);
      const del = await request(app).delete('/api/admin/projects/1').set('Authorization', `Bearer ${superToken}`);
      expect(del.status).toBe(403);
    } finally {
      await db('feature_flags').where({ key: 'projects' }).update({ value: 1 });
    }
  });
});

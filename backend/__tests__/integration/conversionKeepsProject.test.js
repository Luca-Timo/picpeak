/**
 * A document made from another stays in its project (migration 121 / 315):
 * quote → contract, quote → gallery, contract → gallery (through its quote
 * and standalone). Before, every conversion dropped project_id, so a project
 * only filled in when each document was linked by hand.
 */
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('conversions keep the project', () => {
  let db; let cleanup; let adminId; let customerId;
  let quoteService; let contractConversions;

  const idOf = (r) => r?.id ?? r;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    // Conversions only carry a project with the feature on (carriedProjectId).
    await db('feature_flags').insert({ key: 'projects', value: 1 }).onConflict('key').merge({ value: 1 });
    quoteService = require('../../src/services/quoteService');
    contractConversions = require('../../src/services/contract/conversions');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function project() {
    const [row] = await db('projects').insert({
      name: 'Hochzeit', status: 'active', customer_account_id: customerId, created_by: adminId,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    return idOf(row);
  }

  async function acceptedQuote(projectId) {
    const dealUuid = crypto.randomUUID();
    const [row] = await db('quotes').insert({
      quote_number: `Q-${dealUuid.slice(0, 8)}`,
      customer_account_id: customerId,
      status: 'accepted',
      currency: 'CHF',
      issue_date: '2027-02-01',
      net_amount_minor: 100000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 100000,
      deal_uuid: dealUuid,
      project_id: projectId,
      created_by_admin_id: adminId,
    }).returning('id');
    return idOf(row);
  }

  it('quote → contract', async () => {
    const projectId = await project();
    const quoteId = await acceptedQuote(projectId);
    const { contractId } = await contractConversions.createFromQuote(quoteId, adminId);
    expect((await db('contracts').where({ id: contractId }).first('project_id')).project_id).toBe(projectId);
  });

  it('quote → gallery', async () => {
    const projectId = await project();
    const quoteId = await acceptedQuote(projectId);
    const { eventId } = await quoteService.convertToEvent(quoteId, adminId, { hold: true, skipInvoices: true });
    expect((await db('events').where({ id: eventId }).first('project_id')).project_id).toBe(projectId);
  });

  it('standalone contract → gallery', async () => {
    const projectId = await project();
    const [row] = await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: `C-${crypto.randomBytes(4).toString('hex')}`,
      status: 'fully_signed',
      issue_date: '2027-02-01',
      project_id: projectId,
      created_at: new Date().toISOString(),
    }).returning('id');
    const { eventId } = await contractConversions.convertToEvent(idOf(row), adminId);
    expect((await db('events').where({ id: eventId }).first('project_id')).project_id).toBe(projectId);
  });

  it('drops the link when the converter does not own the project', async () => {
    const role = await db('roles').where({ name: 'editor' }).first('id');
    const [editorRow] = await db('admin_users').insert({
      username: 'conv-editor', email: 'conv-editor@example.com', password_hash: 'x', role_id: role.id,
      is_active: true, created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    const editorId = idOf(editorRow);
    const projectId = await project(); // created by the seeded admin, not the editor
    const projectService = require('../../src/services/projectService');
    expect(await projectService.carriedProjectId(projectId, editorId)).toBeNull();
    expect(await projectService.carriedProjectId(projectId, adminId)).toBe(projectId);
    expect(await projectService.carriedProjectId(null, adminId)).toBeNull();
  });

  it('a quote with no project makes a gallery with no project', async () => {
    const quoteId = await acceptedQuote(null);
    const { eventId } = await quoteService.convertToEvent(quoteId, adminId, { hold: true, skipInvoices: true });
    expect((await db('events').where({ id: eventId }).first('project_id')).project_id).toBeNull();
  });
});

/**
 * Catalog-driven event-type defaults (#800 follow-up).
 *
 * The contract→event conversion used to hardcode `event_type: 'wedding'` and
 * the v1 API validated against a fixed whitelist. Both now follow the live
 * event_types catalog; these tests pin the shared resolver.
 */

const { bootCrmDb } = require('./helpers/crmDb');

describe('resolveDefaultEventType follows the catalog', () => {
  let db;
  let cleanup;
  let eventTypeService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    // Require AFTER bootCrmDb so the service shares this db instance
    // (see crmDb.js — a second knex pool on one SQLite file deadlocks).
    eventTypeService = require('../../src/services/eventTypeService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it("prefers the 'other' catch-all while it is active", async () => {
    expect(await eventTypeService.resolveDefaultEventType()).toBe('other');
  });

  it('falls over to the first active type when other is deactivated', async () => {
    const other = await db('event_types').where({ slug_prefix: 'other' }).first();
    await db('event_types').where({ id: other.id }).update({ is_active: 0 });

    const resolved = await eventTypeService.resolveDefaultEventType();
    expect(resolved).not.toBe('other');
    expect(await db('event_types').where({ slug_prefix: resolved }).first()).toBeTruthy();

    await db('event_types').where({ id: other.id }).update({ is_active: 1 });
  });

  it("returns the literal 'other' only for an empty catalog", async () => {
    const rows = await db('event_types').select('*');
    await db('event_types').del();

    expect(await eventTypeService.resolveDefaultEventType()).toBe('other');

    await db('event_types').insert(rows);
  });
});

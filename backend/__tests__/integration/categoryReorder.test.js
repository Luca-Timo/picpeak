/**
 * Per-event category reordering (#782).
 *
 * Covers the three moving parts of the feature against a real SQLite DB with
 * the full core-migration set applied:
 *   1. migration 158 backfills display_order from the previous alphabetical
 *      order per scope, so existing galleries don't reshuffle on upgrade.
 *   2. POST /reorder persists a new order and is scoped to the event's own
 *      (non-global) categories — it must reject out-of-scope and global ids
 *      (the same class of cross-event bug as the v1 upload guard, #500).
 *   3. Creating a category appends it to the end of its scope rather than
 *      letting it jump into the middle of an admin-defined order.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(30000);

describe('category reordering (#782)', () => {
  let db;
  let cleanup;
  let token;
  let app;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = buildRouteApp('/api/admin/categories', require('../../src/routes/adminCategories'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const auth = (r) => r.set('Authorization', `Bearer ${token}`);

  async function insertCat(name, { is_global = false, event_id = null, display_order = 0 } = {}) {
    const res = await db('photo_categories').insert({
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      is_global: is_global ? 1 : 0,
      event_id,
      display_order,
    }).returning('id');
    return res[0]?.id ?? res[0];
  }

  describe('migration 158 backfill', () => {
    it('seeds display_order from alphabetical order, scoped per event', async () => {
      const eventId = 9001;
      // Insert in NON-alphabetical order, all display_order 0 — the state a
      // pre-158 install would be in.
      await insertCat('Reception', { event_id: eventId });
      await insertCat('Ceremony', { event_id: eventId });
      await insertCat('Pre-Ceremony', { event_id: eventId });
      await insertCat('Highlights', { is_global: true });

      // Re-run the migration: addColumn is hasColumn-guarded (no-op), and the
      // backfill loop re-runs, assigning per-scope alphabetical order — i.e.
      // exactly what a real upgrade does to existing rows.
      await require('../../migrations/core/158_add_category_display_order').up(db);

      const evCats = await db('photo_categories')
        .where({ event_id: eventId })
        .orderBy('display_order', 'asc');
      expect(evCats.map((c) => c.name)).toEqual(['Ceremony', 'Pre-Ceremony', 'Reception']);
      expect(evCats.map((c) => c.display_order)).toEqual([1, 2, 3]);

      // Globals are numbered within their own scope (default globals are
      // seeded by the core migrations, so absolute positions vary): ordering
      // by display_order must equal ordering by name, contiguous from 1.
      const byOrder = await db('photo_categories').where('is_global', 1).orderBy('display_order', 'asc');
      const byName = await db('photo_categories').where('is_global', 1).orderBy('name', 'asc');
      expect(byOrder.map((c) => c.id)).toEqual(byName.map((c) => c.id));
      expect(byOrder.map((c) => c.display_order)).toEqual(byName.map((_, i) => i + 1));
    });
  });

  describe('POST /reorder', () => {
    const eventId = 9002;
    const ids = {};

    beforeAll(async () => {
      // Alphabetical seed order: Cer(1), Pre(2), Rec(3).
      ids.cer = await insertCat('Cer', { event_id: eventId, display_order: 1 });
      ids.pre = await insertCat('Pre', { event_id: eventId, display_order: 2 });
      ids.rec = await insertCat('Rec', { event_id: eventId, display_order: 3 });
    });

    it('persists a new order and returns the event categories in it', async () => {
      const res = await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: eventId, orderedIds: [ids.pre, ids.cer, ids.rec] })
        .expect(200);

      const evNames = res.body
        .filter((c) => !c.is_global && c.event_id === eventId)
        .map((c) => c.name);
      expect(evNames).toEqual(['Pre', 'Cer', 'Rec']);

      const rows = await db('photo_categories')
        .whereIn('id', [ids.pre, ids.cer, ids.rec])
        .orderBy('display_order', 'asc');
      expect(rows.map((r) => r.id)).toEqual([ids.pre, ids.cer, ids.rec]);
    });

    it('rejects ids belonging to a different event (out of scope)', async () => {
      const otherId = await insertCat('Other', { event_id: 9999, display_order: 1 });
      await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: eventId, orderedIds: [ids.pre, otherId] })
        .expect(400);
      // The out-of-scope category must be untouched.
      const other = await db('photo_categories').where({ id: otherId }).first();
      expect(other.display_order).toBe(1);
    });

    it('rejects a global category id (globals keep their global order)', async () => {
      const globalId = await insertCat('Shared', { is_global: true, display_order: 5 });
      await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: eventId, orderedIds: [ids.pre, globalId] })
        .expect(400);
    });

    it('rejects an empty or malformed payload', async () => {
      await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ event_id: eventId, orderedIds: [] })
        .expect(400);
      await auth(request(app).post('/api/admin/categories/reorder'))
        .send({ orderedIds: [ids.pre] })
        .expect(400);
    });
  });

  describe('POST / (create) appends to the end of its scope', () => {
    it('assigns display_order = max + 1 within the event', async () => {
      const eventId = 9003;
      await insertCat('First', { event_id: eventId, display_order: 1 });
      await insertCat('Second', { event_id: eventId, display_order: 2 });

      const res = await auth(request(app).post('/api/admin/categories'))
        .send({ name: 'Third', is_global: false, event_id: eventId })
        .expect(200);

      expect(res.body.display_order).toBe(3);
    });
  });
});

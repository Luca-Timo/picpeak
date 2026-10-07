/**
 * Migration 269: team members on a gallery and review of their uploads
 * (issue 743). Guarded on every table and column, so it is a no-op on a
 * second run; down() removes exactly what up() added.
 */
const knex = require('knex');
const migration = require('../../migrations/core/269_event_admin_assignments_and_upload_review');

describe('migration 269 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('admin_users', (t) => {
      t.increments('id').primary();
      t.string('username');
    });
    await db.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.string('slug');
      t.integer('created_by');
    });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.string('filename');
      t.string('visibility');
    });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the table and columns, keeps existing events out of review, and runs again', async () => {
    await db('events').insert({ slug: 'existing', created_by: null });
    await migration.up(db);

    expect(await db.schema.hasTable('event_admin_assignments')).toBe(true);
    expect(await db.schema.hasColumn('events', 'review_contributor_uploads')).toBe(true);
    expect(await db.schema.hasColumn('photos', 'moderation_status')).toBe(true);
    expect(await db.schema.hasColumn('photos', 'uploaded_by_admin_id')).toBe(true);
    expect(Boolean((await db('events').first()).review_contributor_uploads)).toBe(false);
    await expect(migration.up(db)).resolves.toBeUndefined();

    await db('admin_users').insert({ id: 5, username: 'anna' });
    await db('event_admin_assignments').insert({ event_id: 1, admin_user_id: 5 });
    await expect(db('event_admin_assignments').insert({ event_id: 1, admin_user_id: 5 })).rejects.toThrow(/UNIQUE/);

    await db('photos').insert({ event_id: 1, filename: 'a.jpg', visibility: 'hidden', moderation_status: 'pending', uploaded_by_admin_id: 5 });
    expect(await db('photos').whereNull('moderation_status').count({ c: '*' }).first()).toEqual({ c: 0 });
  });

  it('down() removes them, and is a no-op without them', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasTable('event_admin_assignments')).toBe(false);
    expect(await db.schema.hasColumn('events', 'review_contributor_uploads')).toBe(false);
    expect(await db.schema.hasColumn('photos', 'moderation_status')).toBe(false);
    expect(await db.schema.hasColumn('photos', 'uploaded_by_admin_id')).toBe(false);
    await expect(migration.down(db)).resolves.toBeUndefined();
  });

  it('does nothing without the base tables', async () => {
    await db.schema.dropTable('photos');
    await db.schema.dropTable('events');
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db.schema.hasTable('event_admin_assignments')).toBe(false);
  });
});

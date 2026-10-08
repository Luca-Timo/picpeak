/**
 * Migration 281: an install that has sent mail keeps the green email accent
 * now that emails follow the brand; a fresh one does not.
 */
const knex = require('knex');
const migration = require('../../migrations/core/281_email_accent_keeps_green');
const { decodeSettingValue } = require('../helpers/settingValue');

describe('migration 281 on SQLite', () => {
  let db;
  const primary = async () => {
    const row = await db('app_settings').where({ setting_key: 'email_primary_color' }).first();
    return row ? decodeSettingValue(db, row.setting_value) : undefined;
  };

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('app_settings', (t) => {
      t.increments('id').primary();
      t.string('setting_key').unique();
      t.text('setting_value');
      t.string('setting_type');
      t.timestamp('updated_at');
    });
    await db.schema.createTable('email_queue', (t) => { t.increments('id').primary(); });
  });

  afterEach(async () => { await db.destroy(); });

  it('leaves a fresh install to follow the brand', async () => {
    await migration.up(db);
    expect(await primary()).toBeUndefined();
  });

  it('pins the green on an install that has sent mail, and runs again', async () => {
    await db('email_queue').insert({});
    await migration.up(db);
    expect(await primary()).toBe('#5C8762');
    await migration.up(db);
    expect(await db('app_settings').count({ c: '*' }).first()).toEqual({ c: 1 });
  });

  it('fills an empty stored value and keeps a colour the admin chose', async () => {
    await db('email_queue').insert({});
    await db('app_settings').insert({ setting_key: 'email_primary_color', setting_value: JSON.stringify(''), setting_type: 'general' });
    await migration.up(db);
    expect(await primary()).toBe('#5C8762');

    await db('app_settings').where({ setting_key: 'email_primary_color' }).update({ setting_value: JSON.stringify('#123456') });
    await migration.up(db);
    expect(await primary()).toBe('#123456');
  });
});

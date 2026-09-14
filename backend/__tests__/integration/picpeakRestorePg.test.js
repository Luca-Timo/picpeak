/**
 * PostgreSQL integration tests for the .picpeak restore robustness fixes.
 * Gated: runs only when PICPEAK_PG_TEST_URL points at a throwaway Postgres DB,
 * e.g.
 *   PICPEAK_PG_TEST_URL="postgres://picpeak:picpeak_secure_pass_2024@127.0.0.1:7102/picpeak_restore_test" \
 *     npx jest __tests__/integration/picpeakRestorePg.test.js
 *
 * Validates the Postgres-specific paths that SQLite can't exercise: identity
 * sequences left stale by explicit-id inserts, pg_get_serial_sequence raising on
 * id-less tables, reinject/role-recreate explicit-id inserts, and FK integrity.
 */
const knex = require('knex');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

maybe('picpeak restore on Postgres', () => {
  let pgDb;
  let svc;

  beforeAll(async () => {
    pgDb = knex({ client: 'pg', connection: PG_URL });

    await pgDb.raw('DROP TABLE IF EXISTS role_permissions, events, admin_users, roles, permissions, app_settings CASCADE');
    await pgDb.schema.createTable('roles', (t) => {
      t.increments('id');
      t.string('name', 50).notNullable().unique();
      t.string('display_name', 100);
      t.integer('priority').defaultTo(0);
      t.boolean('is_system').defaultTo(false);
    });
    await pgDb.schema.createTable('permissions', (t) => {
      t.increments('id');
      t.string('name', 100).notNullable().unique();
      t.string('display_name', 150);
      t.string('category', 50);
    });
    await pgDb.schema.createTable('role_permissions', (t) => {
      t.integer('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
      t.integer('permission_id').notNullable().references('id').inTable('permissions').onDelete('CASCADE');
      t.primary(['role_id', 'permission_id']);
    });
    await pgDb.schema.createTable('admin_users', (t) => {
      t.increments('id');
      t.string('username').notNullable().unique();
      t.string('email').notNullable().unique();
      t.string('password_hash');
      t.boolean('is_active').defaultTo(true);
      t.boolean('must_change_password').defaultTo(false);
      t.integer('role_id').references('id').inTable('roles').onDelete('SET NULL');
      t.integer('created_by').references('id').inTable('admin_users').onDelete('SET NULL');
      t.boolean('two_factor_enabled').defaultTo(false);
      t.string('two_factor_secret');
      t.text('two_factor_recovery_codes');
    });
    await pgDb.schema.createTable('events', (t) => {
      t.increments('id');
      t.string('slug');
      t.integer('created_by').references('id').inTable('admin_users').onDelete('SET NULL');
    });
    await pgDb.schema.createTable('app_settings', (t) => {
      t.increments('id');
      t.string('setting_key').notNullable().unique();
      t.json('setting_value');
      t.string('setting_type');
      t.timestamp('updated_at').defaultTo(pgDb.fn.now());
    });

    jest.resetModules();
    jest.doMock('../../knexfile', () => ({ client: 'pg' }));
    jest.doMock('../../src/database/db', () => ({ db: pgDb }));
    svc = require('../../src/services/picpeakImportService');
  });

  afterAll(async () => {
    jest.dontMock('../../src/database/db');
    jest.dontMock('../../knexfile');
    if (pgDb) await pgDb.destroy();
  });

  beforeEach(async () => {
    await pgDb('role_permissions').del();
    await pgDb('events').del();
    await pgDb('admin_users').del();
    await pgDb('roles').del();
    await pgDb('permissions').del();
  });

  test('resyncSequences fast-forwards stale sequences and skips id-less tables', async () => {
    // Simulate a restore: explicit-id inserts leave the sequence at 1.
    await pgDb('roles').insert([{ id: 5, name: 'super_admin', display_name: 'SA' }]);
    await pgDb('admin_users').insert([{ id: 9, username: 'a', email: 'a@x.io', password_hash: 'h' }]);
    await pgDb('permissions').insert([{ id: 3, name: 'events.create', display_name: 'C', category: 'events' }]);
    await pgDb('role_permissions').insert([{ role_id: 5, permission_id: 3 }]); // id-less table

    // Must not throw on role_permissions (no `id` column → pg_get_serial_sequence raises unguarded).
    await expect(svc.resyncSequences(['roles', 'admin_users', 'permissions', 'role_permissions'])).resolves.toBeUndefined();

    // Natural inserts (no explicit id) now avoid the restored ids.
    const [adminId] = await pgDb('admin_users').insert({ username: 'b', email: 'b@x.io', password_hash: 'h' }).returning('id');
    expect(Number(adminId.id || adminId)).toBe(10); // max(9)+1, no duplicate-key error
    const [roleId] = await pgDb('roles').insert({ name: 'editor', display_name: 'Ed' }).returning('id');
    expect(Number(roleId.id || roleId)).toBe(6);
  });

  test('reinjectCurrentAdmin insert branch works with a stale sequence (explicit max+1)', async () => {
    await pgDb('admin_users').insert({ id: 9, username: 'backup', email: 'backup@x.io', password_hash: 'h' });
    const operator = { id: 1, username: 'admin', email: 'op@x.io', password_hash: 'OP', is_active: true, created_by: 42 };

    await pgDb.transaction((trx) => svc.reinjectCurrentAdmin(trx, operator));

    const op = await pgDb('admin_users').where({ email: 'op@x.io' }).first();
    expect(op.id).toBe(10);            // max(9)+1
    expect(op.password_hash).toBe('OP');
    expect(op.created_by).toBeNull();  // self-ref FK nulled so the insert can't dangle
  });

  test('preserveOperatorRole re-creates a missing role on Postgres and keeps FK integrity', async () => {
    await pgDb('permissions').insert([{ id: 3, name: 'events.create', display_name: 'C', category: 'events' }]);
    await pgDb('roles').insert([{ id: 2, name: 'viewer', display_name: 'V' }]);
    await pgDb('admin_users').insert({ id: 1, username: 'admin', email: 'op@x.io', password_hash: 'h', role_id: null });
    const snapshot = { role: { name: 'super_admin', display_name: 'SA', priority: 100, is_system: true }, permissions: ['events.create', 'missing.perm'] };

    await pgDb.transaction((trx) => svc.preserveOperatorRole(trx, 1, snapshot));
    await svc.resyncSequences(['roles']); // post-commit, mirrors importFromPicpeak

    const role = await pgDb('roles').where({ name: 'super_admin' }).first();
    expect(role).toBeTruthy();
    const op = await pgDb('admin_users').where({ id: 1 }).first();
    expect(op.role_id).toBe(role.id);  // FK valid, operator not downgraded
    const grants = await pgDb('role_permissions').where({ role_id: role.id }).pluck('permission_id');
    expect(grants).toEqual([3]);        // existing perm granted, missing.perm skipped
  });

  test('full replaceAllTables: cross-instance backup preserves the operator, role, FKs, and sequences', async () => {
    // A backup from ANOTHER instance: omits the operator's email AND their
    // super_admin role; uses explicit ids that leave sequences stale.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pgtest-'));
    const dataDir = path.join(staging, 'data');
    fs.mkdirSync(dataDir);
    const write = (t, rows) => fs.writeFileSync(path.join(dataDir, `${t}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n'));
    write('roles', [{ id: 5, name: 'admin', display_name: 'Admin', priority: 50, is_system: true }]);
    write('permissions', [{ id: 3, name: 'events.create', display_name: 'C', category: 'events' }]);
    write('role_permissions', [{ role_id: 5, permission_id: 3 }]);
    write('admin_users', [{ id: 9, username: 'backupadmin', email: 'backup@x.io', password_hash: 'h', role_id: 5, is_active: true }]);
    write('events', [{ id: 2, slug: 'restored-ev', created_by: 9 }]);

    const operator = { id: 1, username: 'admin', email: 'op@x.io', password_hash: 'OP', is_active: true, role_id: 999, created_by: null };
    const roleSnapshot = { role: { name: 'super_admin', display_name: 'Super Admin', priority: 100, is_system: true }, permissions: ['events.create'] };
    const tables = ['roles', 'permissions', 'role_permissions', 'admin_users', 'events'];

    // replaceAllTables isn't exported, so drive its exact transaction sequence
    // (suspend FKs, wipe, batchInsert, reinject, preserve role) through the
    // exported units against real Postgres.
    const importSvc = svc;
    await pgDb.transaction(async (trx) => {
      await trx.raw('SET session_replication_role = \'replica\'');
      for (const t of tables) await trx(t).del();
      for (const t of tables) {
        const rows = fs.readFileSync(path.join(dataDir, `${t}.ndjson`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        if (rows.length) await trx.batchInsert(t, rows, 100);
      }
      const opId = await importSvc.reinjectCurrentAdmin(trx, operator);
      await importSvc.preserveOperatorRole(trx, opId, roleSnapshot);
      await trx.raw('SET session_replication_role = \'origin\'');
    });
    await importSvc.resyncSequences(tables);

    // Operator preserved (inserted, since email absent from backup).
    const op = await pgDb('admin_users').where({ email: 'op@x.io' }).first();
    expect(op).toBeTruthy();
    expect(op.password_hash).toBe('OP');
    // super_admin role re-created and the operator bound to it.
    const sa = await pgDb('roles').where({ name: 'super_admin' }).first();
    expect(sa).toBeTruthy();
    expect(op.role_id).toBe(sa.id);
    expect(await pgDb('role_permissions').where({ role_id: sa.id }).pluck('permission_id')).toEqual([3]);
    // Restored event's created_by FK to the backup admin still valid.
    const ev = await pgDb('events').where({ slug: 'restored-ev' }).first();
    expect(ev.created_by).toBe(9);
    // Sequences resynced → natural inserts don't collide.
    const [newAdmin] = await pgDb('admin_users').insert({ username: 'fresh', email: 'fresh@x.io', password_hash: 'h' }).returning('id');
    expect(Number(newAdmin.id || newAdmin)).toBeGreaterThan(op.id);

    fs.rmSync(staging, { recursive: true, force: true });
  });
});

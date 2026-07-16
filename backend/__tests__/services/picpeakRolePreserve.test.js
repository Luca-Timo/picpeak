/**
 * Tests for preserveOperatorRole — re-establishing the operator's authorization
 * after a restore replaces the roles / permissions / role_permissions tables.
 * Real in-memory SQLite so the joins and inserts behave as in production.
 */
const knex = require('knex');

let db;
let svc;

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('roles', (t) => {
    t.increments('id');
    t.string('name').notNullable().unique();
    t.string('display_name');
    t.integer('priority').defaultTo(0);
    t.boolean('is_system').defaultTo(false);
  });
  await db.schema.createTable('permissions', (t) => {
    t.increments('id');
    t.string('name').notNullable().unique();
    t.string('display_name');
    t.string('category');
  });
  await db.schema.createTable('role_permissions', (t) => {
    t.integer('role_id').notNullable();
    t.integer('permission_id').notNullable();
    t.primary(['role_id', 'permission_id']);
  });
  await db.schema.createTable('admin_users', (t) => {
    t.increments('id');
    t.string('email');
    t.integer('role_id');
  });
  jest.resetModules();
  jest.doMock('../../knexfile', () => ({ client: 'sqlite3' }));
  jest.doMock('../../src/database/db', () => ({ db }));
  svc = require('../../src/services/picpeakImportService');
});

afterEach(async () => {
  jest.dontMock('../../src/database/db');
  jest.dontMock('../../knexfile');
  await db.destroy();
});

test('captureOperatorRole returns the role + its permission names', async () => {
  await db('roles').insert({ id: 1, name: 'super_admin', display_name: 'Super Admin', priority: 100 });
  await db('permissions').insert([
    { id: 1, name: 'events.create', display_name: 'Create', category: 'events' },
    { id: 2, name: 'users.manage', display_name: 'Manage', category: 'users' },
  ]);
  await db('role_permissions').insert([{ role_id: 1, permission_id: 1 }, { role_id: 1, permission_id: 2 }]);

  const snap = await svc.captureOperatorRole(1);
  expect(snap.role.name).toBe('super_admin');
  expect(snap.permissions.sort()).toEqual(['events.create', 'users.manage']);
});

test('preserveOperatorRole binds to a restored role of the same NAME (ids remapped)', async () => {
  const snapshot = { role: { name: 'super_admin', display_name: 'Super Admin', priority: 100, is_system: true }, permissions: ['events.create'] };
  // Simulate post-restore RBAC where super_admin now has a DIFFERENT id.
  await db('roles').insert({ id: 7, name: 'super_admin', display_name: 'Super Admin (restored)', priority: 100 });
  await db('admin_users').insert({ id: 3, email: 'op@example.com', role_id: null });

  await db.transaction((trx) => svc.preserveOperatorRole(trx, 3, snapshot));

  const op = await db('admin_users').where({ id: 3 }).first();
  expect(op.role_id).toBe(7);                           // bound to restored super_admin by name
  expect(await db('roles').count({ c: '*' }).first()).toEqual({ c: 1 }); // no duplicate role created
});

test('preserveOperatorRole re-creates the role + grants when the backup omits it', async () => {
  const snapshot = {
    role: { name: 'super_admin', display_name: 'Super Admin', priority: 100, is_system: true },
    permissions: ['events.create', 'users.manage', 'gone.permission'],
  };
  // Post-restore RBAC WITHOUT super_admin; only some permissions exist.
  await db('roles').insert({ id: 2, name: 'viewer', display_name: 'Viewer', priority: 10 });
  await db('permissions').insert([
    { id: 5, name: 'events.create', display_name: 'Create', category: 'events' },
    { id: 6, name: 'users.manage', display_name: 'Manage', category: 'users' },
  ]);
  await db('admin_users').insert({ id: 3, email: 'op@example.com', role_id: null });

  await db.transaction((trx) => svc.preserveOperatorRole(trx, 3, snapshot));

  const recreated = await db('roles').where({ name: 'super_admin' }).first();
  expect(recreated).toBeTruthy();                      // role re-created, not left missing
  expect(recreated.id).toBe(3);                        // max(2)+1

  const op = await db('admin_users').where({ id: 3 }).first();
  expect(op.role_id).toBe(recreated.id);               // operator not locked out / downgraded

  const grants = await db('role_permissions').where({ role_id: recreated.id }).pluck('permission_id');
  expect(grants.sort()).toEqual([5, 6]);               // existing perms re-granted; 'gone.permission' skipped
});

test('preserveOperatorRole no-ops when the operator had no role', async () => {
  await db('admin_users').insert({ id: 3, email: 'op@example.com', role_id: null });
  await db.transaction((trx) => svc.preserveOperatorRole(trx, 3, null));
  const op = await db('admin_users').where({ id: 3 }).first();
  expect(op.role_id).toBeNull();
});

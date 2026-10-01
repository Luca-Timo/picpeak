/**
 * Migration 259 — the events.support / view_all / manage_all split must leave
 * every existing role with exactly what it had, plus only the listed additions:
 *   - events.support for every role holding events.edit (custom roles too)
 *   - events.view_all for the role named `admin`
 *   - all three for super_admin
 * and it seeds customer_support only when no role of that name exists.
 */
const path = require('path'), fs = require('fs'), os = require('os');
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig259-')), 'db.sqlite');
process.env.JWT_SECRET = 'mig';
const { bootCrmDb } = require('../integration/helpers/crmDb');
const mig = require('../../migrations/core/259_gallery_admin_cleanup');

const NEW = ['events.support', 'events.view_all', 'events.manage_all'];

async function grantsByRole(db) {
  const rows = await db('role_permissions')
    .join('roles', 'roles.id', 'role_permissions.role_id')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .select('roles.name as role', 'permissions.name as perm');
  const map = {};
  for (const { role, perm } of rows) (map[role] ||= new Set()).add(perm);
  return map;
}

async function addRole(db, name, perms) {
  await db('roles').insert({ name, display_name: name, is_system: false, priority: 10, created_at: new Date(), updated_at: new Date() });
  const role = await db('roles').where({ name }).first();
  const ids = (await db('permissions').whereIn('name', perms).select('id')).map((p) => p.id);
  if (ids.length) await db('role_permissions').insert(ids.map((id) => ({ role_id: role.id, permission_id: id })));
}

describe('migration 259 permissions', () => {
  let db, cleanup;
  beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('projects grants forward without taking or adding anything else', async () => {
    await mig.down(db);
    await addRole(db, 'custom_editor', ['events.view', 'events.edit', 'photos.view']);
    await addRole(db, 'custom_viewer', ['events.view', 'photos.view']);
    const before = await grantsByRole(db);
    expect(before.customer_support).toBeUndefined();

    await mig.up(db);
    const after = await grantsByRole(db);

    for (const [role, perms] of Object.entries(before)) {
      const gained = [...(after[role] || [])].filter((p) => !perms.has(p));
      const lost = [...perms].filter((p) => !(after[role] || new Set()).has(p));
      expect({ role, lost }).toEqual({ role, lost: [] });
      const expected = [];
      if (role === 'super_admin') expected.push(...NEW);
      else {
        if (perms.has('events.edit')) expected.push('events.support');
        if (role === 'admin') expected.push('events.view_all');
      }
      expect({ role, gained: gained.sort() }).toEqual({ role, gained: expected.sort() });
    }
    expect([...after.customer_support].sort()).toEqual([...mig.CUSTOMER_SUPPORT.permissions].sort());
  });

  it('is idempotent', async () => {
    const once = await grantsByRole(db);
    await mig.up(db);
    const twice = await grantsByRole(db);
    expect(Object.fromEntries(Object.entries(twice).map(([k, v]) => [k, [...v].sort()])))
      .toEqual(Object.fromEntries(Object.entries(once).map(([k, v]) => [k, [...v].sort()])));
  });

  it('never overwrites an existing customer_support role', async () => {
    await mig.down(db);
    await addRole(db, 'customer_support', ['events.view']);
    await mig.up(db);
    const after = await grantsByRole(db);
    expect([...after.customer_support]).toEqual(['events.view']);
  });
});

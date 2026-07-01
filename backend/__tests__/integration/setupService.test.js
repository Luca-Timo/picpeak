'use strict';

// First-run bootstrap service. bootCrmDb() must run BEFORE requiring the service
// so setupService shares this test's db instance (see crmDb.js note).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const { bootCrmDb } = require('./helpers/crmDb');

let db;
let cleanup;
let setupService;
let getAppSetting;
let upsertAppSetting;

const VALID_PW = 'Str0ng-Passw0rd!';

// bootCrmDb MUST run before any require of db.js (directly or transitively via a
// service/util), or db.js binds to the default path instead of the temp one.
beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  setupService = require('../../src/services/setupService');
  ({ getAppSetting, upsertAppSetting } = require('../../src/utils/appSettings'));
}, 60000);

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await db('admin_users').del();
  await db('app_settings').where({ setting_key: 'setup_token' }).del();
});

describe('setupService (first-run bootstrap)', () => {
  it('reports needsAdmin while no admin exists', async () => {
    expect(await setupService.getSetupStatus()).toEqual({ needsAdmin: true, complete: false });
  });

  it('generates and persists a one-time token while no admin exists', async () => {
    const token = await setupService.ensureSetupToken();
    expect(token).toEqual(expect.any(String));
    expect(token.length).toBeGreaterThan(20);
    expect(await getAppSetting('setup_token')).toBe(token);
    // Idempotent — a second call returns the same token, not a fresh one.
    expect(await setupService.ensureSetupToken()).toBe(token);
  });

  it('rejects a wrong token', async () => {
    await setupService.ensureSetupToken();
    await expect(
      setupService.createInitialAdmin({ token: 'nope', email: 'a@b.co', password: VALID_PW })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await setupService.getSetupStatus()).toEqual({ needsAdmin: true, complete: false });
  });

  it('rejects a weak password', async () => {
    const token = await setupService.ensureSetupToken();
    await expect(
      setupService.createInitialAdmin({ token, email: 'a@b.co', password: 'weak' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('creates the first admin as super_admin, issues a token, and burns the setup token', async () => {
    const token = await setupService.ensureSetupToken();
    const result = await setupService.createInitialAdmin({
      token, email: 'Owner@Example.com', password: VALID_PW, ip: '203.0.113.7',
    });

    expect(result.user.email).toBe('owner@example.com'); // normalised
    expect(result.user.role.name).toBe('super_admin');
    expect(result.token).toEqual(expect.any(String));

    const row = await db('admin_users').first();
    const role = await db('roles').where({ name: 'super_admin' }).first();
    expect(row.role_id).toBe(role.id);
    expect(row.password_hash).not.toBe(VALID_PW); // hashed

    // One-time: token burned, status now complete.
    expect(await getAppSetting('setup_token')).toBeFalsy();
    expect(await setupService.getSetupStatus()).toEqual({ needsAdmin: false, complete: true });
  });

  it('refuses to create a second admin (setup already complete)', async () => {
    const token = await setupService.ensureSetupToken();
    await setupService.createInitialAdmin({ token, email: 'first@example.com', password: VALID_PW });
    await expect(
      setupService.createInitialAdmin({ token, email: 'second@example.com', password: VALID_PW })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('ensureSetupToken clears any stale token once an admin exists', async () => {
    const token = await setupService.ensureSetupToken();
    await setupService.createInitialAdmin({ token, email: 'first@example.com', password: VALID_PW });
    // Simulate a stale token left in settings, then re-run the boot hook.
    await upsertAppSetting('setup_token', 'stale', 'string');
    expect(await setupService.ensureSetupToken()).toBeNull();
    expect(await getAppSetting('setup_token')).toBeFalsy();
  });
});

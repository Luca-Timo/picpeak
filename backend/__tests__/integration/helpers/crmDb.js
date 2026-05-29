/**
 * Test harness for CRM integration tests.
 *
 * Boots a temp-SQLite database, runs every `migrations/core/*.up()`
 * directly (bypassing knex's Migrator — its exclusive write lock
 * deadlocks 001_init's nested `initializeDatabase()` call), and
 * exposes a small helper for seeding the minimal row set that the
 * quote/contract/invoice services need to operate.
 *
 * Usage:
 *
 *   const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
 *
 *   beforeAll(async () => {
 *     ({ db, cleanup } = await bootCrmDb());
 *     ({ adminId, customerId } = await seedMinimal(db));
 *   });
 *   afterAll(async () => { await cleanup(); });
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcrypt');

async function runCoreMigrations(db) {
  await db.schema.createTable('migrations', (t) => {
    t.increments('id').primary();
    t.string('filename').unique().notNullable();
    t.timestamp('applied_at').defaultTo(db.fn.now());
  });

  const coreDir = path.resolve(__dirname, '..', '..', '..', 'migrations', 'core');
  const files = (await fs.promises.readdir(coreDir))
    .filter((f) => f.endsWith('.js'))
    .sort();

  for (const f of files) {
    const mod = require(path.join(coreDir, f));
    if (typeof mod.up === 'function') {
      await mod.up(db);
    }
    await db('migrations').insert({ filename: f });
  }
}

/**
 * Boot a clean test DB. Returns { db, cleanup, tmpDir }.
 * Caller must invoke cleanup() in afterAll to release the SQLite file
 * and the temp directory.
 */
async function bootCrmDb() {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-crm-'));
  process.env.NODE_ENV = 'test';
  process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'crm.db');
  process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
  await fs.promises.mkdir(process.env.STORAGE_PATH, { recursive: true });

  // No jest.resetModules() — every service the test later requires
  // must share THIS db instance. Two module copies on one SQLite file
  // each open their own knex pool and the SQLite write lock deadlocks
  // the second one acquiring a connection. Caller is responsible for
  // setting TEST_DATABASE_PATH before the first require of db.js
  // (which knexfile reads at module-init time); bootCrmDb only works
  // when invoked before any service import.
  const { db } = require('../../../src/database/db');

  await runCoreMigrations(db);

  return {
    db,
    tmpDir,
    cleanup: async () => {
      try { await db.destroy(); } catch (_) {}
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

/**
 * Seed the minimal row set that quote/contract/invoice services
 * dereference on creation: an admin user, an active customer, a
 * business_profile row, and the app_settings keys the services read.
 *
 * Returns the ids the caller will pass into service calls.
 */
async function seedMinimal(db) {
  const passwordHash = await bcrypt.hash('test-pass', 4); // low rounds = fast

  const adminInsert = await db('admin_users').insert({
    username: 'tester', email: 'tester@example.com',
    password_hash: passwordHash, must_change_password: false,
    created_at: new Date(),
  }).returning('id');
  const adminId = adminInsert[0]?.id ?? adminInsert[0];

  // business_profile is a singleton; the row is seeded by migration 107
  // for fresh installs. Defensive: insert if missing.
  const profile = await db('business_profile').first();
  if (!profile) {
    await db('business_profile').insert({
      legal_name: 'Test Studio',
      default_currency: 'CHF',
      default_locale: 'de',
    });
  }

  const customerInsert = await db('customer_accounts').insert({
    email: 'customer@example.com',
    display_name: 'Test Customer',
    password_hash: passwordHash,
    preferred_language: 'de',
    is_active: 1,
    created_at: new Date(),
  }).returning('id');
  const customerId = customerInsert[0]?.id ?? customerInsert[0];

  return { adminId, customerId };
}

module.exports = { bootCrmDb, seedMinimal };

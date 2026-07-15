/**
 * Setup-window event type deletion (#800).
 *
 * The first-run setup wizard may delete the seeded SYSTEM event types —
 * but ONLY while the `setup_wizard_completed` flag is unset (migration 161
 * seeds it false on a fresh install, true when an admin already exists).
 * These tests pin the whole contract:
 *
 *   - fresh install → flag false → system types deletable (in-use checks
 *     still apply), and the per-type reminder template goes with the type
 *   - reminder-template self-heal does NOT resurrect templates for slugs
 *     that no longer exist in the catalog
 *   - after markSetupWizardCompleted() → system deletion is refused again
 *   - resolveDefaultEventType never returns a hardcoded slug that the
 *     admin removed (contract→event conversion default, #800)
 */

const { bootCrmDb } = require('./helpers/crmDb');

describe('event type deletion during the setup window (#800)', () => {
  let db;
  let cleanup;
  let eventTypeService;
  let setupService;
  let ensureEventReminderTemplatesSeeded;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    // Require AFTER bootCrmDb so every service shares this db instance
    // (see crmDb.js — a second knex pool on one SQLite file deadlocks).
    eventTypeService = require('../../src/services/eventTypeService');
    setupService = require('../../src/services/setupService');
    ({ ensureEventReminderTemplatesSeeded } = require('../../src/services/eventReminderTemplates'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('migration 161 seeds the flag false on a fresh (admin-less) install', async () => {
    const row = await db('app_settings').where({ setting_key: 'setup_wizard_completed' }).first();
    expect(row).toBeTruthy();
    expect(JSON.parse(row.setting_value)).toBe(false);
    expect(await setupService.isSetupWizardCompleted()).toBe(false);
  });

  it('refuses to delete a system type that events already use, even in the window', async () => {
    const corporate = await db('event_types').where({ slug_prefix: 'corporate' }).first();
    await db('events').insert({
      slug: 'corporate-test-2026-01-01',
      event_name: 'Test',
      event_type: 'corporate',
      event_date: '2026-01-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: 'share-corporate-test',
      expires_at: new Date(Date.now() + 86400000),
    });

    await expect(eventTypeService.deleteEventType(corporate.id))
      .rejects.toMatchObject({ code: 'IN_USE' });
  });

  it('deletes an unused system type in the window, taking its reminder template along', async () => {
    // Seed the per-type reminder templates first so there is something to clean up.
    await ensureEventReminderTemplatesSeeded(db);
    expect(await db('email_templates').where({ template_key: 'event_reminder_wedding' }).first()).toBeTruthy();

    const wedding = await db('event_types').where({ slug_prefix: 'wedding' }).first();
    expect(wedding.is_system).toBeTruthy();

    const result = await eventTypeService.deleteEventType(wedding.id);
    expect(result.success).toBe(true);

    expect(await db('event_types').where({ slug_prefix: 'wedding' }).first()).toBeFalsy();
    expect(await db('email_templates').where({ template_key: 'event_reminder_wedding' }).first()).toBeFalsy();
  });

  it('does not resurrect reminder templates for deleted types on the next self-heal pass', async () => {
    // The seeder caches success per process — reset the module to force a
    // genuine second pass, exactly what a backend restart would run.
    jest.resetModules();
    const fresh = require('../../src/services/eventReminderTemplates');
    await fresh.ensureEventReminderTemplatesSeeded(db);

    expect(await db('email_templates').where({ template_key: 'event_reminder_wedding' }).first()).toBeFalsy();
    // Types still in the catalog keep their templates.
    expect(await db('email_templates').where({ template_key: 'event_reminder_birthday' }).first()).toBeTruthy();
    expect(await db('email_templates').where({ template_key: 'event_reminder_default' }).first()).toBeTruthy();
  });

  it('re-locks system types once the wizard is marked complete', async () => {
    await setupService.markSetupWizardCompleted();
    expect(await setupService.isSetupWizardCompleted()).toBe(true);

    const birthday = await db('event_types').where({ slug_prefix: 'birthday' }).first();
    await expect(eventTypeService.deleteEventType(birthday.id))
      .rejects.toMatchObject({ code: 'SYSTEM_TYPE' });

    // Custom (non-system) types remain deletable as before.
    const custom = await eventTypeService.createEventType({ name: 'Family', slug_prefix: 'family' });
    const result = await eventTypeService.deleteEventType(custom.id);
    expect(result.success).toBe(true);
  });

  it('resolveDefaultEventType follows the catalog instead of hardcoding a slug', async () => {
    // 'other' is active → preferred catch-all.
    expect(await eventTypeService.resolveDefaultEventType()).toBe('other');

    // Deactivate 'other' → falls over to the first active type by display order.
    const other = await db('event_types').where({ slug_prefix: 'other' }).first();
    await db('event_types').where({ id: other.id }).update({ is_active: 0 });
    const resolved = await eventTypeService.resolveDefaultEventType();
    expect(resolved).not.toBe('other');
    const resolvedRow = await db('event_types').where({ slug_prefix: resolved }).first();
    expect(resolvedRow).toBeTruthy();

    await db('event_types').where({ id: other.id }).update({ is_active: 1 });
  });
});

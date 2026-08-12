/**
 * Migration: Granular permissions + role presets
 *
 * Phase 1 of the multi-photographer epic (issues #743/#747): make every feature
 * permission-gateable so multi-user studios can split capability across roles.
 *
 * This migration ONLY defines the permission catalog + seeds grants/presets. The
 * route-level enforcement (pointing endpoints at the new perms) lives in the
 * route files. Splitting the perms here is inert until a route references them.
 *
 * What it does:
 *   1. Split the catch-all `settings.edit` into dedicated DANGEROUS-config perms
 *      (banking / domains / security / integrations / features) so a team member
 *      can be granted day-to-day settings without the ability to break IBAN,
 *      domains, SSO, webhooks or feature toggles. Grants project forward from
 *      every role that holds `settings.edit` today — nobody loses capability on
 *      upgrade (see feedback_permission_split_compat). Today `settings.edit` is
 *      super_admin-only, so in practice only super_admin gains the split perms.
 *   2. Add dedicated view/manage perms for feature areas that previously borrowed
 *      generic perms (calendar, deals, transfers, whatsapp, tax report, vat codes,
 *      event types, short urls, css templates, image security, notifications,
 *      system) so each can be carved into a custom role independently.
 *   3. Grant every new perm to `super_admin` (the tracks-all owner). The boot
 *      self-heal (_permissionsBoot.js) keeps super_admin complete on every future
 *      release, so a new perm never needs a compensation migration.
 *   4. Seed the `solo_photographer` preset role — a full operator (studio owner)
 *      granted every current permission. It is a frozen preset: future-release
 *      perms are NOT auto-added (only super_admin tracks all); the owner grants
 *      them via the role editor if wanted.
 *
 * Idempotent throughout (existing-name / existing-grant checks) so a re-run or a
 * partially-applied state is safe.
 */

// ---------------------------------------------------------------------------
// New DANGEROUS-config permissions split out of `settings.edit`.
// `settings.edit` is retained as the SAFE everyday bucket (branding text,
// general prefs, display formats, SEO/analytics copy, public-site content).
// ---------------------------------------------------------------------------
const SETTINGS_SPLIT_PERMISSIONS = [
  { name: 'settings.banking',      display_name: 'Manage Banking & Payment Config', category: 'settings', description: 'Edit bank accounts / IBAN, QR-bill, the issuer block and VAT/accounting config. Sensitive — governs where money is collected.' },
  { name: 'settings.domains',      display_name: 'Manage Domain & URL Config',      category: 'settings', description: 'Edit the public base URL / domain settings used in links and emails.' },
  { name: 'settings.security',     display_name: 'Manage Security & SSO Config',     category: 'settings', description: 'Edit security policy, rate limits and single sign-on (OIDC) login settings.' },
  { name: 'settings.integrations', display_name: 'Manage Integrations',              category: 'settings', description: 'Manage outbound webhooks and API tokens.' },
  { name: 'settings.features',     display_name: 'Manage Feature Toggles',           category: 'settings', description: 'Enable or disable application features (feature flags).' },
];

// ---------------------------------------------------------------------------
// Dedicated per-feature permissions. view = day-to-day read, manage = configure.
// ---------------------------------------------------------------------------
// Dedicated perms for admin surfaces that were miscategorised under the generic
// `settings.*` bucket. Their writes were super_admin-only (settings.edit), so
// pointing them here doesn't strip any existing role. Areas that already have a
// sensible domain gate (calendar→customers, deals→customers/bills,
// transfers→events, tax report→bills, short URLs→events, css templates→branding)
// are intentionally left on those gates for now — finer carving there ships with
// the phase-2 photographer role (needs forward-projection to stay compat-safe).
const FEATURE_PERMISSIONS = [
  { name: 'whatsapp.view',        display_name: 'View WhatsApp',           category: 'whatsapp', description: 'View WhatsApp messaging status and config.' },
  { name: 'whatsapp.manage',      display_name: 'Manage WhatsApp',         category: 'whatsapp', description: 'Configure and send via WhatsApp.' },

  { name: 'roles.manage',         display_name: 'Manage Roles',            category: 'users',    description: 'Create, edit and delete roles and their permission sets. Highly privileged — a holder can grant any capability, so keep it to owners.' },

  { name: 'vat_codes.view',       display_name: 'View VAT Codes',          category: 'accounting', description: 'Read the VAT-code list (used by document editors).' },

  { name: 'event_types.view',     display_name: 'View Event Types',        category: 'events',   description: 'Read the event-type list (used when creating events).' },
  { name: 'event_types.manage',   display_name: 'Manage Event Types',      category: 'events',   description: 'Create, edit and delete event types.' },

  { name: 'image_security.view',  display_name: 'View Image Security',     category: 'photos',   description: 'View image-protection / watermarking settings and access logs.' },
  { name: 'image_security.manage',display_name: 'Manage Image Security',   category: 'photos',   description: 'Configure image protection, block IPs and clear access logs.' },

  { name: 'notifications.view',   display_name: 'View Notifications',       category: 'system',   description: 'View admin notifications.' },
  { name: 'notifications.manage', display_name: 'Manage Notifications',     category: 'system',   description: 'Mark read and clear admin notifications.' },

  { name: 'system.view',          display_name: 'View System',             category: 'system',   description: 'View system status, version, updates and health.' },
  { name: 'system.manage',        display_name: 'Manage System',           category: 'system',   description: 'Configure update notifications and run system maintenance actions.' },
];

const ALL_NEW_PERMISSIONS = [...SETTINGS_SPLIT_PERMISSIONS, ...FEATURE_PERMISSIONS];

// Preset roles shipped by the app. `permissions: 'ALL'` = every current perm.
// Both are frozen system roles: future-release perms are NOT auto-added (only
// super_admin tracks all); the owner tweaks them via the role editor.
const SOLO_PHOTOGRAPHER = {
  name: 'solo_photographer',
  display_name: 'Solo Photographer',
  description: 'Full operator for a one-person studio — everything needed to run the business (galleries, uploads, CRM, invoices, banking, settings and team management). A preset starting point; new-release permissions are not auto-added (only Super Admin tracks all).',
  is_system: true,
  priority: 90, // between super_admin (100) and admin (80)
  permissions: 'ALL',
};

// Team Photographer — a second/festival shooter who contributes photos but is
// NOT the customer contact: view events + upload/edit/download photos, plus
// read-only CRM context (customers/quotes/invoices). No settings, users,
// billing edits, or events.edit (so no transfers/projects/guests either). The
// "only their assigned events" scoping is phase 2 (#743 event assignment).
const TEAM_PHOTOGRAPHER = {
  name: 'team_photographer',
  display_name: 'Team Photographer',
  description: 'Contributing photographer (second/festival shooter) — view events, upload and manage photos, and see read-only client context. Not the customer contact: no settings, user management, billing edits or event configuration. A preset starting point.',
  is_system: true,
  priority: 40, // between editor (50) and viewer (20)
  permissions: [
    'events.view',
    'photos.view', 'photos.upload', 'photos.edit', 'photos.download',
    'customers.view', 'quotes.view', 'bills.view',
  ],
};

const PRESET_ROLES = [SOLO_PHOTOGRAPHER, TEAM_PHOTOGRAPHER];

exports.up = async function (knex) {
  const hasPermissions = await knex.schema.hasTable('permissions');
  const hasRolePermissions = await knex.schema.hasTable('role_permissions');
  const hasRoles = await knex.schema.hasTable('roles');
  if (!hasPermissions || !hasRolePermissions || !hasRoles) {
    console.log('174: RBAC tables missing, skipping permission seed');
    return;
  }

  // 1. Insert all new permissions (skip any already present).
  {
    const existing = await knex('permissions')
      .whereIn('name', ALL_NEW_PERMISSIONS.map((p) => p.name))
      .select('name');
    const existingSet = new Set(existing.map((r) => r.name));
    const toInsert = ALL_NEW_PERMISSIONS.filter((p) => !existingSet.has(p.name));
    if (toInsert.length > 0) {
      await knex('permissions').insert(toInsert);
      console.log(`174: inserted ${toInsert.length} new permissions`);
    }
  }

  // Helper: insert (role_id, permission_id) grants without duplicates.
  const grantPerms = async (roleId, permIds) => {
    if (!roleId || permIds.length === 0) return;
    const existing = await knex('role_permissions')
      .where({ role_id: roleId })
      .whereIn('permission_id', permIds)
      .select('permission_id');
    const have = new Set(existing.map((r) => r.permission_id));
    const inserts = permIds
      .filter((id) => !have.has(id))
      .map((id) => ({ role_id: roleId, permission_id: id }));
    if (inserts.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < inserts.length; i += batchSize) {
        await knex('role_permissions').insert(inserts.slice(i, i + batchSize));
      }
    }
  };

  // 2. Project the settings.edit split forward: every role that holds
  //    settings.edit today gets each new settings.* perm too (compat).
  {
    const editPerm = await knex('permissions').where({ name: 'settings.edit' }).first();
    const splitPerms = await knex('permissions')
      .whereIn('name', SETTINGS_SPLIT_PERMISSIONS.map((p) => p.name))
      .select('id');
    const splitIds = splitPerms.map((p) => p.id);
    if (editPerm && splitIds.length > 0) {
      const rolesWithEdit = await knex('role_permissions')
        .where({ permission_id: editPerm.id })
        .select('role_id');
      for (const { role_id } of rolesWithEdit) {
        await grantPerms(role_id, splitIds);
      }
    }
  }

  // 3. Grant EVERY new permission to super_admin (the tracks-all owner).
  {
    const superAdmin = await knex('roles').where({ name: 'super_admin' }).first();
    if (superAdmin) {
      const newPerms = await knex('permissions')
        .whereIn('name', ALL_NEW_PERMISSIONS.map((p) => p.name))
        .select('id');
      await grantPerms(superAdmin.id, newPerms.map((p) => p.id));
    }
  }

  // 4. Seed the preset roles (Solo + Team Photographer). Each is created with
  //    its grant set ONLY when missing; an existing preset is left untouched
  //    (frozen — the owner may have customised it).
  for (const preset of PRESET_ROLES) {
    const existing = await knex('roles').where({ name: preset.name }).first();
    if (existing) continue;
    await knex('roles').insert({
      name: preset.name,
      display_name: preset.display_name,
      description: preset.description,
      is_system: preset.is_system,
      priority: preset.priority,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
    const role = await knex('roles').where({ name: preset.name }).first();
    let permIds;
    if (preset.permissions === 'ALL') {
      permIds = (await knex('permissions').select('id')).map((p) => p.id);
    } else {
      const rows = await knex('permissions').whereIn('name', preset.permissions).select('id');
      permIds = rows.map((p) => p.id);
    }
    await grantPerms(role.id, permIds);
    console.log(`174: seeded ${preset.name} preset (${permIds.length} permissions)`);
  }

  console.log('174: granular permissions + presets migration complete');
};

exports.down = async function (knex) {
  const hasPermissions = await knex.schema.hasTable('permissions');
  if (!hasPermissions) return;

  const names = ALL_NEW_PERMISSIONS.map((p) => p.name);
  const perms = await knex('permissions').whereIn('name', names).select('id');
  const ids = perms.map((p) => p.id);
  if (ids.length > 0) {
    await knex('role_permissions').whereIn('permission_id', ids).del();
    await knex('permissions').whereIn('id', ids).del();
  }

  // Remove the preset roles and their grants.
  for (const preset of PRESET_ROLES) {
    const role = await knex('roles').where({ name: preset.name }).first();
    if (role) {
      await knex('role_permissions').where({ role_id: role.id }).del();
      await knex('admin_users').where({ role_id: role.id }).update({ role_id: null });
      await knex('roles').where({ id: role.id }).del();
    }
  }
};

module.exports.ALL_NEW_PERMISSIONS = ALL_NEW_PERMISSIONS;
module.exports.SETTINGS_SPLIT_PERMISSIONS = SETTINGS_SPLIT_PERMISSIONS;
module.exports.FEATURE_PERMISSIONS = FEATURE_PERMISSIONS;
module.exports.SOLO_PHOTOGRAPHER = SOLO_PHOTOGRAPHER;
module.exports.TEAM_PHOTOGRAPHER = TEAM_PHOTOGRAPHER;
module.exports.PRESET_ROLES = PRESET_ROLES;

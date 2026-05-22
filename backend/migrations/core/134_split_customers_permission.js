/**
 * Migration: split the single `customers.create` RBAC permission into
 * three distinct scopes so the Customer Management UI can hand out
 * narrower privileges to assistants and ops staff:
 *
 *   - `customers.create` — invite + create passive customers + revoke
 *                          pending invitations (existing scope, kept).
 *   - `customers.edit`   — edit customer records, manage hour-logging
 *                          entries, trigger password resets and the
 *                          admin-override monthly bill fire.
 *   - `customers.events` — manage which events a customer is linked to.
 *
 * **Why split**
 *
 * The previous bundling meant any admin who could file a new customer
 * invitation could also (a) silently retarget billing details on every
 * existing customer they could see, and (b) re-assign customers to
 * arbitrary events — including hot-archive galleries they weren't
 * directly authorised to touch. An assistant who only needs to send
 * out invitations should not also be able to overwrite VAT IDs or move
 * customers between weddings.
 *
 * **Backward compatibility**
 *
 * Every role that currently holds `customers.create` is granted the
 * two new permissions on apply. No human-administered role loses any
 * power — they keep everything they had, just expressed across three
 * permissions instead of one. Admins who want to differentiate after
 * the upgrade revoke `customers.edit` / `customers.events` from the
 * narrower roles via the Role editor.
 *
 * **Idempotency**
 *
 * Standard guard: insert permissions only if the name isn't already
 * present; insert role grants only if the (role, perm) pair isn't
 * already present. Re-applying the migration is a no-op.
 */

exports.up = async function (knex) {
  // Step 1: insert the two new permission rows if they don't already
  // exist (someone may have pre-seeded them by hand).
  const existing = await knex('permissions')
    .select('name')
    .whereIn('name', ['customers.edit', 'customers.events']);
  const existingNames = new Set(existing.map((r) => r.name));
  const toInsert = [
    {
      name: 'customers.edit',
      display_name: 'Edit Customers',
      category: 'customers',
      description:
        'Edit customer records, manage hour-logging entries, trigger '
        + 'password resets, and fire admin-override monthly bills.',
    },
    {
      name: 'customers.events',
      display_name: 'Assign Customers to Events',
      category: 'customers',
      description:
        'Add or remove the events a customer is linked to. '
        + 'Does not grant the ability to edit the customer record.',
    },
  ].filter((p) => !existingNames.has(p.name));
  if (toInsert.length > 0) {
    await knex('permissions').insert(toInsert);
  }

  // Step 2: grant the two new permissions to every role currently
  // holding `customers.create`. Preserves existing access patterns —
  // no role loses capability on upgrade. The role-by-role narrowing is
  // an opt-in admin action via the Role editor.
  const createPerm = await knex('permissions')
    .where({ name: 'customers.create' }).first();
  if (!createPerm) {
    // Nothing to project — older install without the seed migration
    // (090) applied. Skip cleanly.
    return;
  }
  const newPerms = await knex('permissions')
    .whereIn('name', ['customers.edit', 'customers.events']).select('id', 'name');
  if (newPerms.length === 0) return;

  const rolesWithCreate = await knex('role_permissions')
    .where({ permission_id: createPerm.id })
    .select('role_id');

  if (rolesWithCreate.length === 0) return;

  const existingGrants = await knex('role_permissions')
    .whereIn('permission_id', newPerms.map((p) => p.id))
    .select('role_id', 'permission_id');
  const existingGrantSet = new Set(
    existingGrants.map((g) => `${g.role_id}-${g.permission_id}`),
  );

  const inserts = [];
  for (const { role_id } of rolesWithCreate) {
    for (const perm of newPerms) {
      const key = `${role_id}-${perm.id}`;
      if (existingGrantSet.has(key)) continue;
      inserts.push({ role_id, permission_id: perm.id });
    }
  }
  if (inserts.length > 0) {
    await knex('role_permissions').insert(inserts);
  }
};

exports.down = async function (knex) {
  // Drop the two new permissions and their grants. `customers.create`
  // is left untouched — it's the original (085+090) seed.
  const perms = await knex('permissions')
    .whereIn('name', ['customers.edit', 'customers.events'])
    .select('id');
  if (perms.length === 0) return;
  const ids = perms.map((p) => p.id);
  await knex('role_permissions').whereIn('permission_id', ids).del();
  await knex('permissions').whereIn('id', ids).del();
};

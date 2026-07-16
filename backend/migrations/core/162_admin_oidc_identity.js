/**
 * Migration 162: OIDC identity binding for admin users (#798).
 *
 * - `auth_provider`    — 'local' (default) or 'oidc'. Which authority owns the
 *                        account's credentials.
 * - `external_subject` — the IdP's stable subject identifier (OIDC `sub`).
 *                        SSO logins match on (auth_provider, external_subject),
 *                        NEVER on email alone — email-matching is an
 *                        account-takeover vector with IdPs that don't verify
 *                        addresses. Nullable: local accounts have none.
 *
 * Composite unique index so one IdP subject can't map to two admin rows.
 * Additive + guarded; existing rows keep working untouched ('local', NULL).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('admin_users', 'auth_provider'))) {
    await knex.schema.alterTable('admin_users', (t) => {
      t.string('auth_provider', 20).notNullable().defaultTo('local');
    });
  }
  if (!(await knex.schema.hasColumn('admin_users', 'external_subject'))) {
    await knex.schema.alterTable('admin_users', (t) => {
      t.string('external_subject', 255).nullable();
      t.unique(['auth_provider', 'external_subject'], {
        indexName: 'admin_users_provider_subject_unique',
      });
    });
  }
};

exports.down = async function down(knex) {
  for (const col of ['external_subject', 'auth_provider']) {
    // eslint-disable-next-line no-await-in-loop
    if (await knex.schema.hasColumn('admin_users', col)) {
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable('admin_users', (t) => t.dropColumn(col));
    }
  }
};

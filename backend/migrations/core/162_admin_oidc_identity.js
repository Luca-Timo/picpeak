/**
 * Migration 162: OIDC identity binding for admin users (#798).
 *
 * - `auth_provider`    — 'local' (default) or 'oidc'. Which authority owns the
 *                        account's credentials.
 * - `external_issuer`  — the validated `iss` of the IdP that owns the subject.
 *                        OIDC only guarantees `sub` uniqueness WITHIN an
 *                        issuer, so bindings match on (iss, sub) — otherwise
 *                        switching `oidc_issuer_url` could map a new
 *                        provider's user onto an old provider's admin when
 *                        their subjects collide.
 * - `external_subject` — the IdP's stable subject identifier (OIDC `sub`).
 *                        SSO logins match on (external_issuer,
 *                        external_subject), NEVER on email alone —
 *                        email-matching is an account-takeover vector with
 *                        IdPs that don't verify addresses. Nullable: local
 *                        accounts have neither.
 *
 * Composite unique index so one IdP identity can't map to two admin rows.
 * Additive + guarded; existing rows keep working untouched ('local', NULL).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('admin_users', 'auth_provider'))) {
    await knex.schema.alterTable('admin_users', (t) => {
      t.string('auth_provider', 20).notNullable().defaultTo('local');
    });
  }
  if (!(await knex.schema.hasColumn('admin_users', 'external_issuer'))) {
    await knex.schema.alterTable('admin_users', (t) => {
      t.string('external_issuer', 512).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('admin_users', 'external_subject'))) {
    await knex.schema.alterTable('admin_users', (t) => {
      t.string('external_subject', 255).nullable();
      t.unique(['external_issuer', 'external_subject'], {
        indexName: 'admin_users_issuer_subject_unique',
      });
    });
  }
};

exports.down = async function down(knex) {
  for (const col of ['external_subject', 'external_issuer', 'auth_provider']) {
    // eslint-disable-next-line no-await-in-loop
    if (await knex.schema.hasColumn('admin_users', col)) {
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable('admin_users', (t) => t.dropColumn(col));
    }
  }
};

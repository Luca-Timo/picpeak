'use strict';

/**
 * Migration 269: team members on a gallery, and review of their uploads
 * (issue 743, phase 2).
 *
 *   event_admin_assignments          admin accounts assigned to an event. An
 *                                    assigned admin reaches the gallery the
 *                                    way its creator does (ownership.js), with
 *                                    its role's permissions as the limit. CRM
 *                                    and transfer data on the event stay the
 *                                    owner's.
 *   events.review_contributor_uploads
 *                                    hold photos an assigned admin uploads
 *                                    until the owner publishes them. Off on
 *                                    every existing event.
 *   photos.moderation_status         NULL = not under review; 'pending' waits
 *                                    for the owner, 'rejected' was turned
 *                                    down. Either way the photo is stored
 *                                    hidden and no gallery viewer sees it.
 *   photos.uploaded_by_admin_id      the admin account that ran an upload.
 *                                    `uploaded_by` keeps meaning admin/guest;
 *                                    watcher and import rows leave this NULL.
 *
 * The FKs cascade on PostgreSQL; SQLite runs without PRAGMA foreign_keys, so
 * the event cascade (adminEvents/helpers.js) and the admin hard delete
 * (userManagementService.js) remove the assignment rows explicitly.
 *
 * Additive and hasTable/hasColumn-guarded throughout.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_admin_assignments'))
    && await knex.schema.hasTable('events') && await knex.schema.hasTable('admin_users')) {
    await knex.schema.createTable('event_admin_assignments', (t) => {
      t.increments('id').primary();
      t.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      t.integer('admin_user_id').unsigned().notNullable()
        .references('id').inTable('admin_users').onDelete('CASCADE');
      t.integer('assigned_by').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      // Also serves the per-event lookups.
      t.unique(['event_id', 'admin_user_id']);
      // adminAuth reads an admin's assignments on every request.
      t.index(['admin_user_id']);
    });
  }

  if (await knex.schema.hasTable('events')
    && !(await knex.schema.hasColumn('events', 'review_contributor_uploads'))) {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('review_contributor_uploads').notNullable().defaultTo(false);
    });
  }

  if (await knex.schema.hasTable('photos')) {
    const hasStatus = await knex.schema.hasColumn('photos', 'moderation_status');
    if (!hasStatus) {
      await knex.schema.alterTable('photos', (t) => {
        t.string('moderation_status', 16).nullable();
        // The review banner counts and the filter list by event.
        t.index(['event_id', 'moderation_status'], 'photos_event_moderation_idx');
      });
    }
    if (!(await knex.schema.hasColumn('photos', 'uploaded_by_admin_id'))) {
      await knex.schema.alterTable('photos', (t) => {
        t.integer('uploaded_by_admin_id').unsigned().nullable()
          .references('id').inTable('admin_users').onDelete('SET NULL');
      });
    }
  }
};

exports.down = async function down(knex) {
  // Dropping a column drops its FK on PostgreSQL; SQLite has no constraint
  // to drop.
  const drop = async (table, cols) => {
    if (!(await knex.schema.hasTable(table))) return;
    for (const col of cols) {
      if (await knex.schema.hasColumn(table, col)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(col));
      }
    }
  };
  await knex.raw('DROP INDEX IF EXISTS photos_event_moderation_idx');
  await drop('photos', ['moderation_status', 'uploaded_by_admin_id']);
  await drop('events', ['review_contributor_uploads']);
  await knex.schema.dropTableIfExists('event_admin_assignments');
};

/**
 * Migration: per-customer hour logging.
 *
 * Adds a fourth per-customer feature flag (matching the existing
 * feature_calendar / feature_quotes / feature_bills triplet) plus a
 * default hourly rate on customer_accounts, and creates a new
 * `customer_hour_entries` table for the logged time blocks themselves.
 *
 * Routing rules wired by customerHoursService:
 *   - feature_hours_logging=true AND billing_cadence='monthly'
 *       → entry save auto-appends a new line item on the running
 *         monthly draft (migration 128); entry locks once the
 *         scheduler arms the draft for send.
 *   - feature_hours_logging=true AND billing_cadence='per_event'
 *       → entry sits at status='unbilled' until admin clicks
 *         "Bill these hours" on the customer detail page.
 *
 * Idempotent (hasTable + hasColumn guards) — follows migration 114's
 * pattern to keep Postgres reruns from crash-looping on duplicate-
 * column / duplicate-index errors.
 */

exports.up = async function(knex) {
  // ---- customer_accounts extensions ------------------------------------
  if (await knex.schema.hasTable('customer_accounts')) {
    if (!(await knex.schema.hasColumn('customer_accounts', 'feature_hours_logging'))) {
      await knex.schema.alterTable('customer_accounts', (table) => {
        table.boolean('feature_hours_logging').notNullable().defaultTo(false);
      });
    }
    if (!(await knex.schema.hasColumn('customer_accounts', 'hourly_rate_minor'))) {
      await knex.schema.alterTable('customer_accounts', (table) => {
        // Default rate in minor units (CHF 150.00 = 15000). Nullable —
        // null means admin must enter a per-entry rate override or the
        // entry save fails.
        table.bigInteger('hourly_rate_minor');
      });
    }
  }

  // ---- customer_hour_entries -------------------------------------------
  if (!(await knex.schema.hasTable('customer_hour_entries'))) {
    await knex.schema.createTable('customer_hour_entries', (table) => {
      table.increments('id').primary();
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');

      table.date('entry_date').notNullable();
      // "HH:MM" — stored as varchar so the editor's <input type="time">
      // round-trips without timezone interpretation. The service
      // computes duration_minutes on save so aggregate queries can
      // sum hours without re-parsing every row.
      table.string('start_time', 5).notNullable();
      table.string('end_time', 5).notNullable();
      table.integer('duration_minutes').notNullable();

      // null = inherit customer.hourly_rate_minor.
      table.bigInteger('hourly_rate_minor_override');

      table.text('description');

      // Lifecycle: 'unbilled' → 'billed' (once folded into an invoice
      // line). 'cancelled' is reserved for a future "soft delete after
      // billing" workflow; for now deletes are hard.
      table.string('status', 16).notNullable().defaultTo('unbilled');

      // Backlink to the invoice + specific line item this entry is on.
      // ON DELETE SET NULL so that purging an invoice doesn't cascade-
      // delete the audit trail (admin can still see the entry's
      // duration + description).
      table.integer('invoice_id').unsigned()
        .references('id').inTable('invoices').onDelete('SET NULL');
      table.integer('invoice_line_item_id').unsigned()
        .references('id').inTable('invoice_line_items').onDelete('SET NULL');
      table.timestamp('billed_at');

      table.integer('recorded_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['customer_account_id', 'status']);
      table.index(['invoice_id']);
    });
  }
};

exports.down = async function(knex) {
  if (await knex.schema.hasTable('customer_hour_entries')) {
    await knex.schema.dropTable('customer_hour_entries');
  }
  if (await knex.schema.hasTable('customer_accounts')) {
    for (const col of ['hourly_rate_minor', 'feature_hours_logging']) {
      if (await knex.schema.hasColumn('customer_accounts', col)) {
        await knex.schema.alterTable('customer_accounts', (table) => {
          table.dropColumn(col);
        });
      }
    }
  }
};

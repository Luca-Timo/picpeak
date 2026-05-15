/**
 * Migration: split the conflated Payment Conditions dropdown into two
 * orthogonal pickers — "Net days" and "Payment timing / split".
 *
 * Today the single `payment_term_templates` row mashes two concepts
 * together: net_days (Net 14/30/60/90, "Sofort fällig") and the
 * installment plan (Komplettzahlung nach Auslieferung / vor Event /
 * nach Event / 3 Raten 30/30/40). That means the admin can't pair
 * "3 Raten" with Net 60 without authoring a custom template covering
 * every combination.
 *
 * This migration introduces two new tables:
 *
 *   - payment_net_days_templates    → name + net_days + optional Skonto
 *   - payment_timing_templates      → name + installments JSON
 *
 * And two new nullable FK columns on `quotes` and `invoices`:
 *
 *   - payment_net_days_template_id
 *   - payment_timing_template_id
 *
 * The legacy `payment_term_templates` table and the
 * `payment_term_template_id` columns stay for now — historical rows
 * still reference them, and the existing `payment_term_snapshot` JSON
 * shape (which the PDF renderer + dunning scheduler consume) is
 * unchanged. The editor stops *writing* to the legacy FK after this
 * PR but the column lives until the next release-cycle cleanup.
 *
 * Backfill: existing quote/invoice rows that point at a legacy
 * payment_term_template get their two new FKs populated by name match
 * against the seeded system rows. Ambiguous rows (e.g. a custom
 * legacy template that doesn't match any seed name) keep the legacy
 * FK + snapshot and the new FKs stay null — they're locked from the
 * UI anyway (status='sent') so this is purely cosmetic.
 *
 * Idempotent — pattern lifted from migration 114 (explicit hasTable /
 * hasColumn guards rather than .catch on alterTable; a swallowed
 * dup-column error in Postgres aborts the surrounding transaction and
 * crash-loops the migration).
 */

const SYSTEM_NET_DAYS = [
  // "Sofort fällig" — invoiced amount is due on the issue date.
  // net_days=0 is supported by computeDueDate (just returns the
  // scheduled-send date unchanged).
  { name: 'Sofort fällig',  net_days: 0,  display_order: 5  },
  { name: 'Net 14',         net_days: 14, display_order: 10 },
  { name: 'Net 30',         net_days: 30, display_order: 20 },
  { name: 'Net 60',         net_days: 60, display_order: 30 },
  { name: 'Net 90',         net_days: 90, display_order: 40 },
];

// Names match the legacy SYSTEM_PAYMENT_TERM_TEMPLATES seeds in
// migration 102 so the backfill can name-match unambiguously.
const SYSTEM_TIMING = [
  {
    name: 'Komplettzahlung nach Auslieferung',
    description: 'Zahlbar nach Erhalt der Bilder, ohne Abzüge.',
    installments: [
      { label: 'Gesamtbetrag nach Auslieferung', percent: 100, trigger: 'after_delivery', offset_days: 0 },
    ],
    display_order: 10,
  },
  {
    name: 'Komplettzahlung vor Event',
    description: 'Zahlbar 7 Tage vor dem Event.',
    installments: [
      { label: 'Gesamtbetrag vor Event', percent: 100, trigger: 'before_event', offset_days: -7 },
    ],
    display_order: 20,
  },
  {
    name: 'Komplettzahlung nach Event',
    description: 'Zahlbar nach dem Event, vor Auslieferung.',
    installments: [
      { label: 'Gesamtbetrag nach Event', percent: 100, trigger: 'after_event', offset_days: 0 },
    ],
    display_order: 30,
  },
  {
    name: '3 Raten 30/30/40',
    description: '30% bei Auftragsbestätigung, 30% vor Event, 40% nach Auslieferung.',
    installments: [
      { label: 'Anzahlung bei Auftragsbestätigung', percent: 30, trigger: 'quote_accepted', offset_days: 0 },
      { label: 'Teilzahlung vor Event', percent: 30, trigger: 'before_event', offset_days: -7 },
      { label: 'Schlusszahlung nach Auslieferung', percent: 40, trigger: 'after_delivery', offset_days: 0 },
    ],
    display_order: 40,
  },
];

exports.up = async function(knex) {
  // ---- payment_net_days_templates --------------------------------------
  if (!(await knex.schema.hasTable('payment_net_days_templates'))) {
    await knex.schema.createTable('payment_net_days_templates', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.string('description', 255);
      table.integer('net_days').notNullable().defaultTo(30);
      // Skonto (early-payment discount) — both nullable when not offered.
      // Lives on the net-days side because it modifies the payment
      // window, not the installment timing.
      table.decimal('skonto_percent', 5, 2);
      table.integer('skonto_within_days');
      table.boolean('is_system').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['is_active']);
      table.index(['is_system']);
    });

    for (const tpl of SYSTEM_NET_DAYS) {
      await knex('payment_net_days_templates').insert({
        name: tpl.name,
        net_days: tpl.net_days,
        is_system: true,
        is_active: true,
        display_order: tpl.display_order,
      });
    }
  }

  // ---- payment_timing_templates ----------------------------------------
  if (!(await knex.schema.hasTable('payment_timing_templates'))) {
    await knex.schema.createTable('payment_timing_templates', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.string('description', 255);
      // Installments JSON — same shape the renderer + scheduler already
      // consume from payment_term_snapshot:
      //   [{ label, percent, trigger, offset_days }, ...]
      table.json('installments').notNullable();
      table.boolean('is_system').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['is_active']);
      table.index(['is_system']);
    });

    for (const tpl of SYSTEM_TIMING) {
      await knex('payment_timing_templates').insert({
        name: tpl.name,
        description: tpl.description,
        installments: JSON.stringify(tpl.installments),
        is_system: true,
        is_active: true,
        display_order: tpl.display_order,
      });
    }
  }

  // ---- quotes: add two new nullable FK columns -------------------------
  if (await knex.schema.hasTable('quotes')) {
    if (!(await knex.schema.hasColumn('quotes', 'payment_net_days_template_id'))) {
      await knex.schema.alterTable('quotes', (table) => {
        table.integer('payment_net_days_template_id').unsigned()
          .references('id').inTable('payment_net_days_templates').onDelete('SET NULL');
      });
    }
    if (!(await knex.schema.hasColumn('quotes', 'payment_timing_template_id'))) {
      await knex.schema.alterTable('quotes', (table) => {
        table.integer('payment_timing_template_id').unsigned()
          .references('id').inTable('payment_timing_templates').onDelete('SET NULL');
      });
    }
  }

  // ---- invoices: add two new nullable FK columns -----------------------
  if (await knex.schema.hasTable('invoices')) {
    if (!(await knex.schema.hasColumn('invoices', 'payment_net_days_template_id'))) {
      await knex.schema.alterTable('invoices', (table) => {
        table.integer('payment_net_days_template_id').unsigned()
          .references('id').inTable('payment_net_days_templates').onDelete('SET NULL');
      });
    }
    if (!(await knex.schema.hasColumn('invoices', 'payment_timing_template_id'))) {
      await knex.schema.alterTable('invoices', (table) => {
        table.integer('payment_timing_template_id').unsigned()
          .references('id').inTable('payment_timing_templates').onDelete('SET NULL');
      });
    }
  }

  // ---- Backfill from legacy payment_term_template_id -------------------
  // Strategy: for each row that has a legacy FK set, look up the
  // legacy template's name + net_days. Match the name against the
  // new timing seeds, and find a matching net_days seed. Where both
  // resolve, populate the new FKs. Where they don't, leave null —
  // the snapshot column still drives PDF rendering for those rows.
  if (await knex.schema.hasTable('payment_term_templates')) {
    const legacy = await knex('payment_term_templates').select('id', 'name', 'net_days');

    // Index the seeded net-days rows by net_days value for O(1) lookup.
    const netDaysSeeds = await knex('payment_net_days_templates').select('id', 'net_days');
    const netDaysByValue = new Map(netDaysSeeds.map((r) => [r.net_days, r.id]));

    // Index the seeded timing rows by name for O(1) lookup.
    const timingSeeds = await knex('payment_timing_templates').select('id', 'name');
    const timingByName = new Map(timingSeeds.map((r) => [r.name, r.id]));

    for (const lt of legacy) {
      const timingId = timingByName.get(lt.name) || null;
      const netDaysId = netDaysByValue.get(lt.net_days) || null;
      if (!timingId && !netDaysId) continue;

      // Quotes
      if (await knex.schema.hasTable('quotes')) {
        await knex('quotes')
          .where({ payment_term_template_id: lt.id })
          .update({
            payment_net_days_template_id: knex.raw('COALESCE(payment_net_days_template_id, ?)', [netDaysId]),
            payment_timing_template_id: knex.raw('COALESCE(payment_timing_template_id, ?)', [timingId]),
          });
      }
      // Invoices
      if (await knex.schema.hasTable('invoices')) {
        await knex('invoices')
          .where({ payment_term_template_id: lt.id })
          .update({
            payment_net_days_template_id: knex.raw('COALESCE(payment_net_days_template_id, ?)', [netDaysId]),
            payment_timing_template_id: knex.raw('COALESCE(payment_timing_template_id, ?)', [timingId]),
          });
      }
    }
  }
};

exports.down = async function(knex) {
  // Drop the FK columns first, then the tables. The legacy
  // `payment_term_templates` / `payment_term_template_id` infrastructure
  // is untouched on the way down so a rollback never strands a quote
  // or invoice.
  for (const tableName of ['invoices', 'quotes']) {
    if (await knex.schema.hasTable(tableName)) {
      for (const col of ['payment_timing_template_id', 'payment_net_days_template_id']) {
        if (await knex.schema.hasColumn(tableName, col)) {
          await knex.schema.alterTable(tableName, (table) => {
            table.dropColumn(col);
          });
        }
      }
    }
  }
  for (const t of ['payment_timing_templates', 'payment_net_days_templates']) {
    if (await knex.schema.hasTable(t)) {
      await knex.schema.dropTable(t);
    }
  }
};

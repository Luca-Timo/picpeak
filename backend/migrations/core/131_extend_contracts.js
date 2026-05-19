/**
 * Migration: extend contracts (migration 130) with three bundles of
 * columns added during the in-flight `feat/crm` work.
 *
 * 1. Event snapshot fields on `contracts` (event_name + event_date
 *    + event_time_start + event_time_end). Mirror quotes.event_* and
 *    invoices.event_* (migration 102 + 123). Propagated from the
 *    source quote on createFromQuote, then snapshotted onto generated
 *    invoices / events so the label survives even when the contract
 *    is later edited or the source quote is purged. Standalone
 *    contracts set them directly via the contract editor.
 *
 * 2. SHA-256 content hashes (pdf_sha256 + signed_pdf_sha256). Audit
 *    defence: computed at every PDF write and stored alongside the
 *    on-disk path. Either party can re-hash the PDF they hold and
 *    prove file integrity without trusting the server.
 *
 * 3. Lineage back-pointers — three columns across two existing
 *    tables and one new column on contracts:
 *      - contracts.source_quote_id   ← FK to quotes, set on
 *                                      createFromQuote
 *      - contracts.converted_event_id ← FK to events, set on
 *                                      convertToEvent
 *      - quotes.converted_contract_id ← FK back to contracts; the
 *                                      QuoteDetailPage's "Linked
 *                                      contract" panel reads this
 *      - invoices.source_contract_id ← FK back to contracts; the
 *                                      BillDetailPage's "From
 *                                      contract" badge reads this
 *    All ON DELETE SET NULL so deleting either side preserves the
 *    other's audit trail.
 *
 * History note: these columns were originally added as in-place
 * edits to migration 130 during the feature's design iteration. Once
 * 130 had been deployed to beta (3.47.2-beta.0) the in-place edits
 * became invisible to that install — knex won't re-run an already-
 * applied migration. This file is the compensating migration that
 * lets beta catch up.
 *
 * When `feat/crm` is consolidated for the upstream/beta PR, the
 * maintainer will fold these columns back into 130 and delete this
 * file. Until then, both files are needed and idempotent.
 *
 * Idempotent — every step checks hasColumn before adding.
 */

exports.up = async function(knex) {
  // ---- contracts: event snapshot fields ---------------------------
  if (await knex.schema.hasTable('contracts')) {
    const hasEventName = await knex.schema.hasColumn('contracts', 'event_name');
    if (!hasEventName) {
      await knex.schema.alterTable('contracts', (table) => {
        table.string('event_name', 255);
        table.date('event_date');
        table.string('event_time_start', 8);
        table.string('event_time_end', 8);
      });
    }

    // ---- contracts: SHA-256 hashes --------------------------------
    if (!(await knex.schema.hasColumn('contracts', 'pdf_sha256'))) {
      await knex.schema.alterTable('contracts', (table) => {
        table.string('pdf_sha256', 64);
      });
    }
    if (!(await knex.schema.hasColumn('contracts', 'signed_pdf_sha256'))) {
      await knex.schema.alterTable('contracts', (table) => {
        table.string('signed_pdf_sha256', 64);
      });
    }

    // ---- contracts: lineage outbound FKs --------------------------
    if (!(await knex.schema.hasColumn('contracts', 'source_quote_id'))) {
      await knex.schema.alterTable('contracts', (table) => {
        table.integer('source_quote_id').unsigned()
          .references('id').inTable('quotes').onDelete('SET NULL');
        table.index(['source_quote_id']);
      });
    }
    if (!(await knex.schema.hasColumn('contracts', 'converted_event_id'))) {
      await knex.schema.alterTable('contracts', (table) => {
        table.integer('converted_event_id').unsigned()
          .references('id').inTable('events').onDelete('SET NULL');
      });
    }
  }

  // ---- quotes: back-pointer to contract ----------------------------
  if (await knex.schema.hasTable('quotes')) {
    if (!(await knex.schema.hasColumn('quotes', 'converted_contract_id'))) {
      await knex.schema.alterTable('quotes', (table) => {
        table.integer('converted_contract_id').unsigned()
          .references('id').inTable('contracts').onDelete('SET NULL');
        table.index(['converted_contract_id']);
      });
    }
  }

  // ---- invoices: back-pointer to source contract -------------------
  if (await knex.schema.hasTable('invoices')) {
    if (!(await knex.schema.hasColumn('invoices', 'source_contract_id'))) {
      await knex.schema.alterTable('invoices', (table) => {
        table.integer('source_contract_id').unsigned()
          .references('id').inTable('contracts').onDelete('SET NULL');
        table.index(['source_contract_id']);
      });
    }
  }
};

exports.down = async function(knex) {
  // Drop the back-pointers on quotes/invoices BEFORE removing the
  // FKs on contracts itself — otherwise the FK constraint blocks
  // any later attempt to drop contracts (e.g. via 130's down).
  if (await knex.schema.hasTable('quotes')) {
    if (await knex.schema.hasColumn('quotes', 'converted_contract_id')) {
      await knex.schema.alterTable('quotes', (table) => {
        table.dropColumn('converted_contract_id');
      });
    }
  }
  if (await knex.schema.hasTable('invoices')) {
    if (await knex.schema.hasColumn('invoices', 'source_contract_id')) {
      await knex.schema.alterTable('invoices', (table) => {
        table.dropColumn('source_contract_id');
      });
    }
  }

  if (await knex.schema.hasTable('contracts')) {
    for (const col of [
      'converted_event_id',
      'source_quote_id',
      'signed_pdf_sha256',
      'pdf_sha256',
      'event_time_end',
      'event_time_start',
      'event_date',
      'event_name',
    ]) {
      if (await knex.schema.hasColumn('contracts', col)) {
        await knex.schema.alterTable('contracts', (table) => {
          table.dropColumn(col);
        });
      }
    }
  }
};

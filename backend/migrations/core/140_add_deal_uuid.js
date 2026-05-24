/**
 * Migration: cross-document lineage UUID + backfill.
 *
 * Adds `deal_uuid` to `quotes`, `contracts`, and `invoices` so every
 * document related to one customer engagement can be retrieved with a
 * single `WHERE deal_uuid = ?` query instead of walking the point-to-
 * point FK graph (source_quote_id → contracts → invoices, plus
 * Storno + reissue chains). New documents inherit the UUID from their
 * parent; orphan creates mint a fresh one.
 *
 * Existing data is backfilled in strict dependency order so chained
 * docs share one uuid:
 *
 *   1. Quotes — always roots in the deal-lineage sense. Each NULL
 *      quote gets a fresh uuid.
 *   2. Contracts — inherit from source_quote_id if present; else
 *      mint fresh. By this point every referenced quote already has
 *      a uuid, so chains resolve cleanly in one pass.
 *   3. Invoices — multi-pass loop, inheritance priority:
 *        source_quote_id → source_contract_id → cancels_invoice_id
 *        → replaces_invoice_id, first hit wins.
 *      Multiple passes because Storno + reissue chains reference
 *      other invoices: a Storno of invoice X needs X minted first.
 *      Any invoice still unresolved after 10 passes is a true
 *      orphan and gets a fresh uuid.
 *
 * Idempotent — every step uses `whereNull('deal_uuid')` so re-running
 * the migration is a no-op on rows that already have a uuid.
 *
 * Schema choice: knex `table.uuid()` maps to `uuid` on Postgres and
 * `char(36)` on SQLite — cross-dialect safe.
 */

const crypto = require('crypto');

async function addColumn(knex, table) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, 'deal_uuid')) return;
  await knex.schema.alterTable(table, (t) => {
    t.uuid('deal_uuid').nullable();
    t.index('deal_uuid', `${table}_deal_uuid_idx`);
  });
}

async function dropColumn(knex, table) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, 'deal_uuid'))) return;
  await knex.schema.alterTable(table, (t) => {
    t.dropIndex('deal_uuid', `${table}_deal_uuid_idx`);
    t.dropColumn('deal_uuid');
  });
}

/**
 * Backfill in strict dependency order so chained docs share one
 * uuid. A naive "mint a uuid for every NULL row, then propagate"
 * approach silently fails because by the time propagation runs,
 * every chained row already has its own uuid and the WHERE-NULL
 * filter skips them — producing N independent uuids for what should
 * have been one connected component.
 *
 * Order:
 *   1. Quotes — always roots in the deal-lineage sense. Each NULL
 *      quote gets a fresh uuid.
 *   2. Contracts — inherit from source_quote_id if present, else
 *      fresh.
 *   3. Invoices — inherit from source_quote_id → source_contract_id
 *      → cancels_invoice_id → replaces_invoice_id, first hit wins.
 *      Looped because Storno + reissue chains reference other
 *      invoices: a Storno of invoice X needs X to already have a
 *      uuid before it can inherit. Up to 10 passes; any invoice
 *      whose chain still resolves to NULL after that gets a fresh
 *      uuid (true orphan).
 *
 * Idempotent: every step uses `whereNull('deal_uuid')` so re-running
 * is a no-op on rows that already have a uuid.
 */
async function backfill(knex) {
  // 1. Quotes — fresh uuid per row.
  if (await knex.schema.hasTable('quotes')) {
    const rows = await knex('quotes').whereNull('deal_uuid').select('id');
    for (const r of rows) {
      await knex('quotes').where({ id: r.id }).update({ deal_uuid: crypto.randomUUID() });
    }
  }

  // 2. Contracts — inherit from source_quote_id if available.
  if (await knex.schema.hasTable('contracts')) {
    const hasSourceQuoteFk = await knex.schema.hasColumn('contracts', 'source_quote_id');
    const rows = await knex('contracts')
      .whereNull('deal_uuid')
      .select(['id', ...(hasSourceQuoteFk ? ['source_quote_id'] : [])]);
    for (const c of rows) {
      let uuid = null;
      if (hasSourceQuoteFk && c.source_quote_id) {
        const q = await knex('quotes').where({ id: c.source_quote_id }).first('deal_uuid');
        uuid = q?.deal_uuid || null;
      }
      uuid = uuid || crypto.randomUUID();
      await knex('contracts').where({ id: c.id }).update({ deal_uuid: uuid });
    }
  }

  // 3. Invoices — multi-pass inheritance because Storno + reissue
  //    chains reference other invoices. Each pass picks up rows
  //    whose chain root now has a uuid.
  if (!(await knex.schema.hasTable('invoices'))) return;
  const hasSrcQuote = await knex.schema.hasColumn('invoices', 'source_quote_id');
  const hasSrcContract = await knex.schema.hasColumn('invoices', 'source_contract_id');
  const hasCancels = await knex.schema.hasColumn('invoices', 'cancels_invoice_id');
  const hasReplaces = await knex.schema.hasColumn('invoices', 'replaces_invoice_id');
  const invoiceSelectCols = ['id'];
  if (hasSrcQuote) invoiceSelectCols.push('source_quote_id');
  if (hasSrcContract) invoiceSelectCols.push('source_contract_id');
  if (hasCancels) invoiceSelectCols.push('cancels_invoice_id');
  if (hasReplaces) invoiceSelectCols.push('replaces_invoice_id');

  for (let iter = 0; iter < 10; iter += 1) {
    const rows = await knex('invoices').whereNull('deal_uuid').select(invoiceSelectCols);
    if (rows.length === 0) break;
    let updated = 0;
    for (const inv of rows) {
      let uuid = null;
      if (hasSrcQuote && inv.source_quote_id) {
        const q = await knex('quotes').where({ id: inv.source_quote_id }).first('deal_uuid');
        uuid = q?.deal_uuid || null;
      }
      if (!uuid && hasSrcContract && inv.source_contract_id) {
        const c = await knex('contracts').where({ id: inv.source_contract_id }).first('deal_uuid');
        uuid = c?.deal_uuid || null;
      }
      if (!uuid && hasCancels && inv.cancels_invoice_id) {
        const i = await knex('invoices').where({ id: inv.cancels_invoice_id }).first('deal_uuid');
        uuid = i?.deal_uuid || null;
      }
      if (!uuid && hasReplaces && inv.replaces_invoice_id) {
        const i = await knex('invoices').where({ id: inv.replaces_invoice_id }).first('deal_uuid');
        uuid = i?.deal_uuid || null;
      }
      if (uuid) {
        await knex('invoices').where({ id: inv.id }).update({ deal_uuid: uuid });
        updated += 1;
      }
    }
    if (updated === 0) {
      // None of the remaining rows resolved through their chain.
      // These are true orphans (no parent FKs set OR all parents
      // unreachable). Mint fresh and break out.
      for (const inv of rows) {
        await knex('invoices').where({ id: inv.id }).update({ deal_uuid: crypto.randomUUID() });
      }
      break;
    }
  }
}

exports.up = async function (knex) {
  for (const table of ['quotes', 'contracts', 'invoices']) {
    await addColumn(knex, table);
  }
  await backfill(knex);
};

exports.down = async function (knex) {
  for (const table of ['quotes', 'contracts', 'invoices']) {
    await dropColumn(knex, table);
  }
};

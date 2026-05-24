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
 * Existing data is backfilled here. The walker has two phases:
 *
 *   Pass A (downward) — for any row missing deal_uuid, copy from any
 *   parent whose deal_uuid is already set. Parent references:
 *     - contracts.source_quote_id          → quotes.deal_uuid
 *     - invoices.source_quote_id           → quotes.deal_uuid
 *     - invoices.source_contract_id        → contracts.deal_uuid
 *     - invoices.cancels_invoice_id        → invoices.deal_uuid
 *     - invoices.replaces_invoice_id       → invoices.deal_uuid
 *
 *   Pass B (upward) — for any row missing deal_uuid, copy from any
 *   child that already has one. Catches the case where the leaf was
 *   minted first (e.g. an invoice that got a UUID via a sibling) and
 *   its parent quote is still bare.
 *
 *   Pass C (orphan) — anything still NULL gets a fresh UUID. Then we
 *   loop back to A+B so the fresh UUID propagates to children.
 *
 * Loop converges because each pass either assigns a UUID (state
 * change) or doesn't (terminate). Idempotent: re-running the migration
 * is a no-op because every row already has a deal_uuid.
 *
 * Schema choice: knex `table.uuid()` maps to `uuid` on Postgres and
 * `char(36)` on SQLite — cross-dialect safe.
 */

const crypto = require('crypto');

// Ordered tuples of (childTable, fkColumn, parentTable) used by Pass A.
const DOWNWARD_LINKS = [
  ['contracts', 'source_quote_id', 'quotes'],
  ['invoices', 'source_quote_id', 'quotes'],
  ['invoices', 'source_contract_id', 'contracts'],
  ['invoices', 'cancels_invoice_id', 'invoices'],
  ['invoices', 'replaces_invoice_id', 'invoices'],
];

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
 * One downward propagation pass. Returns the number of rows updated.
 * SQLite + Postgres both accept a correlated subquery in UPDATE; we
 * use this shape rather than UPDATE…FROM to stay portable.
 */
async function downwardPass(knex) {
  let updated = 0;
  for (const [child, fk, parent] of DOWNWARD_LINKS) {
    const hasChild = await knex.schema.hasTable(child);
    const hasParent = await knex.schema.hasTable(parent);
    if (!hasChild || !hasParent) continue;
    const hasChildFk = await knex.schema.hasColumn(child, fk);
    if (!hasChildFk) continue;
    // Pull (child_id, parent.deal_uuid) for child rows without a uuid
    // whose parent does have one, and write them back. Doing this in
    // node-land sidesteps cross-dialect UPDATE FROM quirks.
    const rows = await knex(child)
      .leftJoin(parent, `${child}.${fk}`, `${parent}.id`)
      .whereNull(`${child}.deal_uuid`)
      .whereNotNull(`${parent}.deal_uuid`)
      .select(`${child}.id`, `${parent}.deal_uuid as parent_uuid`);
    for (const r of rows) {
      await knex(child).where({ id: r.id }).update({ deal_uuid: r.parent_uuid });
      updated += 1;
    }
  }
  return updated;
}

/**
 * One upward propagation pass. For each table, look at any child
 * row that DOES have a deal_uuid pointing at this row, and copy back.
 * Uses the same DOWNWARD_LINKS table inverted.
 */
async function upwardPass(knex) {
  let updated = 0;
  for (const [child, fk, parent] of DOWNWARD_LINKS) {
    const hasChild = await knex.schema.hasTable(child);
    const hasParent = await knex.schema.hasTable(parent);
    if (!hasChild || !hasParent) continue;
    const hasChildFk = await knex.schema.hasColumn(child, fk);
    if (!hasChildFk) continue;
    // For each parent row without a uuid, find SOME child with the FK
    // pointing at it that has one. First match wins; subsequent
    // children with the same uuid are no-ops because they're already
    // consistent (siblings share a uuid by construction).
    const candidates = await knex(parent)
      .whereNull(`${parent}.deal_uuid`)
      .select('id');
    for (const cand of candidates) {
      const childRow = await knex(child)
        .where({ [fk]: cand.id })
        .whereNotNull('deal_uuid')
        .first('deal_uuid');
      if (childRow) {
        await knex(parent).where({ id: cand.id }).update({ deal_uuid: childRow.deal_uuid });
        updated += 1;
      }
    }
  }
  return updated;
}

/**
 * Mint a fresh UUID for every row still missing one. Runs after
 * propagation has converged. Then we re-run propagation so the new
 * UUIDs reach their connected component.
 */
async function mintOrphans(knex) {
  let minted = 0;
  for (const table of ['quotes', 'contracts', 'invoices']) {
    if (!(await knex.schema.hasTable(table))) continue;
    const rows = await knex(table).whereNull('deal_uuid').select('id');
    for (const r of rows) {
      await knex(table).where({ id: r.id }).update({ deal_uuid: crypto.randomUUID() });
      minted += 1;
    }
  }
  return minted;
}

async function backfill(knex) {
  // Phase 1: propagate any existing deal_uuids (none yet on first run,
  // but the same code path handles incremental re-application).
  for (let i = 0; i < 10; i += 1) {
    const a = await downwardPass(knex);
    const b = await upwardPass(knex);
    if (a + b === 0) break;
  }
  // Phase 2: orphans get fresh UUIDs.
  const minted = await mintOrphans(knex);
  if (minted === 0) return;
  // Phase 3: propagate the fresh UUIDs through their connected
  // components (orphans may have descendants that were also NULL).
  for (let i = 0; i < 10; i += 1) {
    const a = await downwardPass(knex);
    const b = await upwardPass(knex);
    if (a + b === 0) break;
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

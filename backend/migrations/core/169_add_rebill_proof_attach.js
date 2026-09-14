/**
 * Migration 169: re-bill proof-attachment support (issue #866).
 *
 *   - inbound_documents.proof_attach_error : best-effort failure marker. When a
 *                                            re-billed supplier invoice's stored
 *                                            proof PDF is missing/unreadable at
 *                                            the moment the client invoice is
 *                                            issued, we DON'T silently drop it —
 *                                            we stamp the reason here so the
 *                                            re-bill row in CRM → Customer shows
 *                                            a recovery banner.
 *   - customer_accounts.rebill_attach_proof: per-customer tri-state override for
 *                                            "attach the supplier proof to the
 *                                            client-invoice email".
 *                                              NULL  = inherit the global default
 *                                              true  = always attach
 *                                              false = never attach
 *                                            The global default itself lives in
 *                                            app_settings (accounting_rebill_
 *                                            attach_proof, default off) and needs
 *                                            no seed row — an absent key coerces
 *                                            to false, exactly like
 *                                            accounting_require_proof.
 *
 * Additive + hasColumn-guarded so re-runs are safe.
 */
async function addColumn(knex, table, column, builder) {
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, builder);
  }
}

exports.up = async function (knex) {
  if (await knex.schema.hasTable('inbound_documents')) {
    await addColumn(knex, 'inbound_documents', 'proof_attach_error', (t) => t.text('proof_attach_error'));
  }
  if (await knex.schema.hasTable('customer_accounts')) {
    // Nullable boolean = tri-state (NULL inherit / true on / false off).
    await addColumn(knex, 'customer_accounts', 'rebill_attach_proof', (t) => t.boolean('rebill_attach_proof').nullable());
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('inbound_documents') && await knex.schema.hasColumn('inbound_documents', 'proof_attach_error')) {
    await knex.schema.alterTable('inbound_documents', (t) => t.dropColumn('proof_attach_error'));
  }
  if (await knex.schema.hasTable('customer_accounts') && await knex.schema.hasColumn('customer_accounts', 'rebill_attach_proof')) {
    await knex.schema.alterTable('customer_accounts', (t) => t.dropColumn('rebill_attach_proof'));
  }
};

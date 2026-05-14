/**
 * Migration: seed Net 14 / 30 / 60 / 90 payment-term templates.
 *
 * The original CRM migration (102) shipped only "Komplettzahlung
 * nach Auslieferung" (net 30, after-delivery installment) as the
 * single net-day-driven template. Admins asked for the classic
 * Net 14 / 30 / 60 / 90 trio (no Skonto, no installments — plain
 * "payable within N days from invoice date") so they can pick one
 * from the existing payment-term dropdown without configuring a
 * custom template first.
 *
 * Skonto on these is intentionally NULL: the user wants Skonto kept
 * separate, on the existing "with-Skonto" templates that they
 * configure manually. These four rows are pure net-days timing.
 *
 * Idempotent: each row is inserted only if no template with the
 * same `name` already exists. Admins who renamed any of these
 * after a previous run won't get duplicates because we look up by
 * the exact seed name.
 */

const NET_TEMPLATES = [
  {
    name: 'Net 14',
    description: 'Zahlbar innerhalb von 14 Tagen ab Rechnungsdatum.',
    net_days: 14,
    // Single installment "due now" — invoice is sent in full, the
    // customer has net_days days to settle. Matches how the renderer
    // expresses "no installment plan" in the rest of the codebase.
    installments: [
      { label: 'Gesamtbetrag', percent: 100, trigger: 'quote_accepted', offset_days: 0 },
    ],
    display_order: 5,
  },
  {
    name: 'Net 30',
    description: 'Zahlbar innerhalb von 30 Tagen ab Rechnungsdatum.',
    net_days: 30,
    installments: [
      { label: 'Gesamtbetrag', percent: 100, trigger: 'quote_accepted', offset_days: 0 },
    ],
    display_order: 6,
  },
  {
    name: 'Net 60',
    description: 'Zahlbar innerhalb von 60 Tagen ab Rechnungsdatum.',
    net_days: 60,
    installments: [
      { label: 'Gesamtbetrag', percent: 100, trigger: 'quote_accepted', offset_days: 0 },
    ],
    display_order: 7,
  },
  {
    name: 'Net 90',
    description: 'Zahlbar innerhalb von 90 Tagen ab Rechnungsdatum.',
    net_days: 90,
    installments: [
      { label: 'Gesamtbetrag', percent: 100, trigger: 'quote_accepted', offset_days: 0 },
    ],
    display_order: 8,
  },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('payment_term_templates'))) return;
  for (const tpl of NET_TEMPLATES) {
    const existing = await knex('payment_term_templates').where({ name: tpl.name }).first();
    if (existing) continue;
    await knex('payment_term_templates').insert({
      name: tpl.name,
      description: tpl.description,
      net_days: tpl.net_days,
      skonto_percent: null,
      skonto_within_days: null,
      installments: JSON.stringify(tpl.installments),
      is_system: true,
      is_active: true,
      display_order: tpl.display_order,
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('payment_term_templates'))) return;
  // Only remove the rows this migration seeded. We match on name +
  // is_system so we don't accidentally delete an admin-created
  // template with the same name (unlikely, but cheap insurance).
  for (const tpl of NET_TEMPLATES) {
    await knex('payment_term_templates')
      .where({ name: tpl.name, is_system: true })
      .del();
  }
};

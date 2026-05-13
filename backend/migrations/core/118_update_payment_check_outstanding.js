/**
 * Migration: update the seeded invoice_payment_check_admin template
 * so it leads with OUTSTANDING + paid-so-far instead of the gross
 * total.
 *
 * Original body (migration 116) asked the admin to confirm whether
 * `total_amount` had been received. That works for fresh invoices
 * but is misleading once a partial payment has been logged — the
 * customer might've paid 134 of 234, but the email kept asking
 * "did they pay 234?".
 *
 * The new body shows:
 *   - Outstanding (the actual question)
 *   - Total (context)
 *   - Already paid (when has_partial_payment is true)
 *
 * Three action buttons unchanged — they already act on outstanding
 * server-side.
 *
 * Schema-aware in the same way as 112/116/117. Always rewrites the
 * row; admins who hand-edited the v1 body lose their changes (the
 * payment-check feature is new enough that custom wording is rare).
 */

const TEMPLATE_KEY = 'invoice_payment_check_admin';

const EN = {
  subject: 'Check payment for invoice {{invoice_number}}',
  body_html: `<h2>Time to check on a payment</h2>
<p>Invoice <strong>{{invoice_number}}</strong> for <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} was due on <strong>{{due_date}}</strong>.</p>
<p><strong>Outstanding: {{outstanding_amount}}</strong>{{#if has_partial_payment}} — {{paid_amount}} of {{total_amount}} already received{{else}} (total {{total_amount}}){{/if}}.</p>
<p>Please check your bank to confirm what (if anything more) has been received, then click the matching button below — no login required.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px auto; border-collapse: collapse;">
  <tr>
    <td style="padding: 0 6px;">
      <a href="{{paid_url}}" style="background: #16a34a; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Outstanding paid in full</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{partial_url}}" style="background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Partial payment</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{unpaid_url}}" style="background: #dc2626; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Nothing received</a>
    </td>
  </tr>
</table>
<p style="font-size: 13px; color: #666;">If you select "Nothing received" or "Partial payment", the system will queue the next reminder to the customer{{#if late_fee_due}} including a late fee of {{late_fee_amount}}{{/if}}.</p>`,
  body_text: `Time to check on a payment

Invoice {{invoice_number}} for {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} was due on {{due_date}}.

Outstanding: {{outstanding_amount}}{{#if has_partial_payment}} ({{paid_amount}} of {{total_amount}} already received){{else}} (total {{total_amount}}){{/if}}.

Confirm what was received:
  Outstanding paid in full:  {{paid_url}}
  Partial payment:           {{partial_url}}
  Nothing received:          {{unpaid_url}}

Selecting "Nothing received" or "Partial payment" will queue the customer reminder{{#if late_fee_due}} including a late fee of {{late_fee_amount}}{{/if}}.`,
};

const DE = {
  subject: 'Zahlung prüfen für Rechnung {{invoice_number}}',
  body_html: `<h2>Zahlung prüfen</h2>
<p>Rechnung <strong>{{invoice_number}}</strong> für <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} war am <strong>{{due_date}}</strong> fällig.</p>
<p><strong>Offen: {{outstanding_amount}}</strong>{{#if has_partial_payment}} — {{paid_amount}} von {{total_amount}} bereits eingegangen{{else}} (Gesamtbetrag {{total_amount}}){{/if}}.</p>
<p>Bitte prüfen Sie auf Ihrem Konto, was zusätzlich eingegangen ist, und klicken Sie unten den passenden Button — kein Login nötig.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px auto; border-collapse: collapse;">
  <tr>
    <td style="padding: 0 6px;">
      <a href="{{paid_url}}" style="background: #16a34a; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Offener Betrag bezahlt</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{partial_url}}" style="background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Teilzahlung</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{unpaid_url}}" style="background: #dc2626; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Nichts eingegangen</a>
    </td>
  </tr>
</table>
<p style="font-size: 13px; color: #666;">Bei „Nichts eingegangen" oder „Teilzahlung" wird automatisch die Zahlungserinnerung an den Kunden gesendet{{#if late_fee_due}} inklusive Mahngebühr von {{late_fee_amount}}{{/if}}.</p>`,
  body_text: `Zahlung prüfen

Rechnung {{invoice_number}} für {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} war am {{due_date}} fällig.

Offen: {{outstanding_amount}}{{#if has_partial_payment}} ({{paid_amount}} von {{total_amount}} bereits eingegangen){{else}} (Gesamtbetrag {{total_amount}}){{/if}}.

Bitte bestätigen:
  Offener Betrag bezahlt:  {{paid_url}}
  Teilzahlung:             {{partial_url}}
  Nichts eingegangen:      {{unpaid_url}}

Bei „Nichts eingegangen" oder „Teilzahlung" wird automatisch die Zahlungserinnerung gesendet{{#if late_fee_due}} inklusive Mahngebühr von {{late_fee_amount}}{{/if}}.`,
};

const VARIABLES = ['invoice_number', 'customer_name', 'event_name', 'due_date',
  'outstanding_amount', 'paid_amount', 'total_amount', 'has_partial_payment',
  'paid_url', 'partial_url', 'unpaid_url',
  'late_fee_due', 'late_fee_amount'];

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const row = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!row) return; // migration 116 not applied yet — bail safely

  const cols = await knex('email_templates').columnInfo();
  const updates = { updated_at: new Date() };
  if ('variables' in cols) updates.variables = JSON.stringify(VARIABLES);

  for (const colName of Object.keys(cols)) {
    if (colName === 'subject' || colName === 'subject_en') updates[colName] = EN.subject;
    else if (colName === 'subject_de') updates[colName] = DE.subject;
    else if (colName === 'body_html' || colName === 'body_html_en') updates[colName] = EN.body_html;
    else if (colName === 'body_html_de') updates[colName] = DE.body_html;
    else if (colName === 'body_text' || colName === 'body_text_en') updates[colName] = EN.body_text;
    else if (colName === 'body_text_de') updates[colName] = DE.body_text;
  }
  await knex('email_templates').where({ id: row.id }).update(updates);

  if (await knex.schema.hasTable('email_template_translations')) {
    for (const [lang, content] of [['en', EN], ['de', DE]]) {
      const existing = await knex('email_template_translations')
        .where({ template_id: row.id, language: lang }).first();
      if (existing) {
        await knex('email_template_translations').where({ id: existing.id }).update({
          subject: content.subject, body_html: content.body_html, body_text: content.body_text,
          updated_at: new Date(),
        });
      } else {
        try {
          await knex('email_template_translations').insert({
            template_id: row.id, language: lang,
            subject: content.subject, body_html: content.body_html, body_text: content.body_text,
            created_at: new Date(), updated_at: new Date(),
          });
        } catch (_) { /* shape variance */ }
      }
    }
  }
};

exports.down = async function(_knex) {
  // No-op rollback — restoring the v1 wording would re-introduce the
  // confusing "did they pay 234?" question this migration fixes.
};

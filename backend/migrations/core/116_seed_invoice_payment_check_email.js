/**
 * Migration: seed `invoice_payment_check_admin` email template
 *
 * The admin receives this when an invoice passes its due date. It
 * contains signed-token action buttons that open a public web page
 * (no login required):
 *
 *   - "Paid in full"        → marks the invoice paid
 *   - "Paid with Skonto"    → marks the invoice paid at the
 *                             discounted total (migration 126).
 *                             Only rendered when Skonto is configured.
 *   - "Partially paid"      → admin enters amount, partial logged,
 *                             reminder fires for the remainder
 *   - "Not paid yet"        → reminder ladder fires (level 1 or 2,
 *                             with Mahngebühr added at level 2)
 *
 * Schema-aware insert pattern matches migration 102/112.
 */

const TEMPLATE_KEY = 'invoice_payment_check_admin';

const EN = {
  subject: 'Check payment for invoice {{invoice_number}}',
  body_html: `<h2>Time to check on a payment</h2>
<p>Invoice <strong>{{invoice_number}}</strong> for <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} was due on <strong>{{due_date}}</strong>. Total: <strong>{{total_amount}}</strong>.</p>
<p>Please check your bank to confirm what (if anything) has been received, then click the matching button below — no login required.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px auto; border-collapse: collapse;">
  <tr>
    <td style="padding: 0 6px;">
      <a href="{{paid_url}}" style="background: #16a34a; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Paid in full</a>
    </td>
    {{#if has_skonto}}<td style="padding: 0 6px;">
      <a href="{{skonto_url}}" style="background: #0d9488; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Paid with Skonto ({{skonto_amount}})</a>
    </td>{{/if}}
    <td style="padding: 0 6px;">
      <a href="{{partial_url}}" style="background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Partially paid</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{unpaid_url}}" style="background: #dc2626; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Not paid yet</a>
    </td>
  </tr>
</table>
<p style="font-size: 13px; color: #666;">If you select "Not paid yet" or "Partially paid", the system will queue the next reminder to the customer{{#if late_fee_due}} including a late fee of {{late_fee_amount}}{{/if}}.</p>`,
  body_text: `Time to check on a payment

Invoice {{invoice_number}} for {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} was due on {{due_date}}. Total: {{total_amount}}.

Confirm what was received:
  Paid in full:           {{paid_url}}{{#if has_skonto}}
  Paid with Skonto ({{skonto_amount}}): {{skonto_url}}{{/if}}
  Partial:                {{partial_url}}
  Not paid yet:           {{unpaid_url}}

Selecting "Not paid yet" or "Partially paid" will queue the customer reminder{{#if late_fee_due}} including a late fee of {{late_fee_amount}}{{/if}}.`,
};

const DE = {
  subject: 'Zahlung prüfen für Rechnung {{invoice_number}}',
  body_html: `<h2>Zahlung prüfen</h2>
<p>Rechnung <strong>{{invoice_number}}</strong> für <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} war am <strong>{{due_date}}</strong> fällig. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>
<p>Bitte prüfen Sie auf Ihrem Konto, was eingegangen ist, und klicken Sie unten den passenden Button — kein Login nötig.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px auto; border-collapse: collapse;">
  <tr>
    <td style="padding: 0 6px;">
      <a href="{{paid_url}}" style="background: #16a34a; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Vollständig bezahlt</a>
    </td>
    {{#if has_skonto}}<td style="padding: 0 6px;">
      <a href="{{skonto_url}}" style="background: #0d9488; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Mit Skonto bezahlt ({{skonto_amount}})</a>
    </td>{{/if}}
    <td style="padding: 0 6px;">
      <a href="{{partial_url}}" style="background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Teilweise bezahlt</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{unpaid_url}}" style="background: #dc2626; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Nicht bezahlt</a>
    </td>
  </tr>
</table>
<p style="font-size: 13px; color: #666;">Bei „Nicht bezahlt" oder „Teilweise bezahlt" wird automatisch die Zahlungserinnerung an den Kunden gesendet{{#if late_fee_due}} inklusive Mahngebühr von {{late_fee_amount}}{{/if}}.</p>`,
  body_text: `Zahlung prüfen

Rechnung {{invoice_number}} für {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} war am {{due_date}} fällig. Gesamtbetrag: {{total_amount}}.

Bitte bestätigen:
  Vollständig bezahlt:            {{paid_url}}{{#if has_skonto}}
  Mit Skonto bezahlt ({{skonto_amount}}): {{skonto_url}}{{/if}}
  Teilweise:                      {{partial_url}}
  Nicht bezahlt:                  {{unpaid_url}}

Bei „Nicht bezahlt" oder „Teilweise bezahlt" wird automatisch die Zahlungserinnerung gesendet{{#if late_fee_due}} inklusive Mahngebühr von {{late_fee_amount}}{{/if}}.`,
};

const TEMPLATE = {
  category: 'bills',
  feature_flag: 'bills',
  variables: ['invoice_number', 'customer_name', 'event_name', 'due_date',
    'total_amount', 'paid_url', 'partial_url', 'unpaid_url',
    'late_fee_due', 'late_fee_amount',
    // Migration 126 — Skonto button. Renders only when has_skonto is truthy.
    'has_skonto', 'skonto_percent', 'skonto_amount', 'skonto_url'],
  en: EN, de: DE,
};

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first()) return;

  const cols = await knex('email_templates').columnInfo();
  const row = {
    template_key: TEMPLATE_KEY,
    variables: JSON.stringify(TEMPLATE.variables),
  };
  if ('category' in cols)     row.category = TEMPLATE.category;
  if ('subcategory' in cols)  row.subcategory = null;
  if ('feature_flag' in cols) row.feature_flag = TEMPLATE.feature_flag;
  if ('created_at' in cols)   row.created_at = new Date();
  if ('updated_at' in cols)   row.updated_at = new Date();

  for (const colName of Object.keys(cols)) {
    if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
      row[colName] = EN.subject;
    } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
      row[colName] = EN.body_html;
    } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
      row[colName] = EN.body_text;
    }
  }
  if ('subject_de' in cols)   row.subject_de   = DE.subject;
  if ('body_html_de' in cols) row.body_html_de = DE.body_html;
  if ('body_text_de' in cols) row.body_text_de = DE.body_text;

  const inserted = await knex('email_templates').insert(row).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (await knex.schema.hasTable('email_template_translations') && templateId) {
    for (const lang of ['en', 'de']) {
      try {
        await knex('email_template_translations').insert({
          template_id: templateId,
          language: lang,
          subject: TEMPLATE[lang].subject,
          body_html: TEMPLATE[lang].body_html,
          body_text: TEMPLATE[lang].body_text,
          created_at: new Date(),
          updated_at: new Date(),
        });
      } catch (_) { /* ignore — shape variance */ }
    }
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (await knex.schema.hasTable('email_template_translations')) {
    const row = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
    if (row?.id) {
      await knex('email_template_translations').where({ template_id: row.id }).del();
    }
  }
  await knex('email_templates').where({ template_key: TEMPLATE_KEY }).del();
};

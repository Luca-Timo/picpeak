/**
 * Migration: seed `invoice_paid_admin_notification` email template.
 *
 * Fires from invoiceService.markPaid when the recorded payments first
 * cover the invoice total (or the Skonto-discounted total — migration
 * 126). The admin's receiving inbox gets a one-shot confirmation:
 *
 *   - invoice number + customer label + paid total
 *   - payment method + reference if set
 *   - "Paid with Skonto X% — discount Y" line ONLY when the payment
 *     was flagged as Skonto-applied (admin ticked the box or clicked
 *     the Skonto button on the payment-check email)
 *
 * This complements `invoice_payment_check_admin` (which asks the
 * admin "did you receive payment?"): once recorded, this template
 * fires so the admin has an audit trail in their inbox without
 * having to scroll through the activity log.
 *
 * Mirrors the schema-aware insert pattern from migrations 102 / 112 /
 * 116. Idempotent — skips when the template already exists.
 */

const TEMPLATE_KEY = 'invoice_paid_admin_notification';

const EN = {
  subject: 'Payment received: invoice {{invoice_number}}',
  body_html: `<h2>Payment recorded</h2>
<p>Invoice <strong>{{invoice_number}}</strong> for <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} has been marked as fully paid.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color: #666;">Total invoice amount</td><td><strong>{{total_amount}}</strong></td></tr>
  <tr><td style="color: #666;">Paid total</td><td><strong>{{paid_amount}}</strong></td></tr>
  {{#if skonto_applied}}<tr><td style="color: #0d9488;">Paid with Skonto ({{skonto_percent}}%)</td><td style="color: #0d9488;"><strong>−{{skonto_discount_amount}}</strong></td></tr>{{/if}}
  {{#if payment_method}}<tr><td style="color: #666;">Payment method</td><td>{{payment_method}}</td></tr>{{/if}}
  {{#if payment_reference}}<tr><td style="color: #666;">Reference</td><td>{{payment_reference}}</td></tr>{{/if}}
  <tr><td style="color: #666;">Recorded at</td><td>{{paid_at}}</td></tr>
</table>
<p style="font-size: 13px; color: #666;">This is an automatic notification — no action required.</p>`,
  body_text: `Payment recorded

Invoice {{invoice_number}} for {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} has been marked as fully paid.

  Total invoice amount:    {{total_amount}}
  Paid total:              {{paid_amount}}{{#if skonto_applied}}
  Paid with Skonto ({{skonto_percent}}%): -{{skonto_discount_amount}}{{/if}}{{#if payment_method}}
  Payment method:          {{payment_method}}{{/if}}{{#if payment_reference}}
  Reference:               {{payment_reference}}{{/if}}
  Recorded at:             {{paid_at}}

This is an automatic notification — no action required.`,
};

const DE = {
  subject: 'Zahlung erhalten: Rechnung {{invoice_number}}',
  body_html: `<h2>Zahlung erfasst</h2>
<p>Rechnung <strong>{{invoice_number}}</strong> für <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} wurde als vollständig bezahlt markiert.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color: #666;">Rechnungsbetrag</td><td><strong>{{total_amount}}</strong></td></tr>
  <tr><td style="color: #666;">Eingezahlt</td><td><strong>{{paid_amount}}</strong></td></tr>
  {{#if skonto_applied}}<tr><td style="color: #0d9488;">Mit Skonto bezahlt ({{skonto_percent}}%)</td><td style="color: #0d9488;"><strong>−{{skonto_discount_amount}}</strong></td></tr>{{/if}}
  {{#if payment_method}}<tr><td style="color: #666;">Zahlungsart</td><td>{{payment_method}}</td></tr>{{/if}}
  {{#if payment_reference}}<tr><td style="color: #666;">Referenz</td><td>{{payment_reference}}</td></tr>{{/if}}
  <tr><td style="color: #666;">Erfasst am</td><td>{{paid_at}}</td></tr>
</table>
<p style="font-size: 13px; color: #666;">Automatische Benachrichtigung — keine Aktion erforderlich.</p>`,
  body_text: `Zahlung erfasst

Rechnung {{invoice_number}} für {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} wurde als vollständig bezahlt markiert.

  Rechnungsbetrag:         {{total_amount}}
  Eingezahlt:              {{paid_amount}}{{#if skonto_applied}}
  Mit Skonto bezahlt ({{skonto_percent}}%): -{{skonto_discount_amount}}{{/if}}{{#if payment_method}}
  Zahlungsart:             {{payment_method}}{{/if}}{{#if payment_reference}}
  Referenz:                {{payment_reference}}{{/if}}
  Erfasst am:              {{paid_at}}

Automatische Benachrichtigung — keine Aktion erforderlich.`,
};

const TEMPLATE = {
  category: 'bills',
  feature_flag: 'bills',
  variables: ['invoice_number', 'customer_name', 'event_name',
    'total_amount', 'paid_amount', 'payment_method', 'payment_reference', 'paid_at',
    // Migration 126 — Skonto marker. The template uses {{#if skonto_applied}}
    // to render the discount line only when the admin ticked the box.
    'skonto_applied', 'skonto_percent', 'skonto_discount_amount'],
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

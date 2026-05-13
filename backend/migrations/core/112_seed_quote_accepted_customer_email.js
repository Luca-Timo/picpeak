/**
 * Migration: seed `quote_accepted_customer` email template
 *
 * Migration 102 seeded admin-facing templates (quote_accepted_admin,
 * quote_declined_admin) but no customer-facing confirmation. This
 * adds one so the customer gets a paper trail when their quote is
 * accepted — whether they clicked Accept on the public response
 * page themselves OR the admin recorded acceptance on their behalf
 * (phone call workflow).
 *
 * One template covers both paths via a conditional snippet: when
 * `accepted_on_behalf` is truthy, an extra sentence tells the
 * customer that the acceptance was recorded by the photographer
 * and to reply if that's unexpected.
 *
 * Idempotent — only inserts when the key is missing.
 */

const EN = {
  subject: 'Quote {{quote_number}} accepted — thank you',
  body_html: `<h2>Thank you</h2>
<p>Dear {{customer_name}},</p>
<p>This confirms that quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}} has been accepted. Total: <strong>{{total_amount}}</strong>.</p>
{{#if accepted_on_behalf}}<p style="font-size: 13px; color: #666;">This acceptance was recorded on your behalf by your photographer. If anything is unclear, please reply directly to this email.</p>{{/if}}
<p>We'll be in touch with next steps shortly.</p>`,
  body_text: `Dear {{customer_name}},

This confirms that quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}} has been accepted. Total: {{total_amount}}.
{{#if accepted_on_behalf}}
This acceptance was recorded on your behalf by your photographer. If anything is unclear, please reply directly to this email.
{{/if}}
We'll be in touch with next steps shortly.`,
};

const DE = {
  subject: 'Angebot {{quote_number}} angenommen — vielen Dank',
  body_html: `<h2>Vielen Dank</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>hiermit bestätigen wir, dass das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für „{{event_name}}"{{/if}} angenommen wurde. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>
{{#if accepted_on_behalf}}<p style="font-size: 13px; color: #666;">Diese Bestätigung wurde stellvertretend durch Ihren Fotografen erfasst. Falls etwas unklar ist, antworten Sie bitte direkt auf diese E-Mail.</p>{{/if}}
<p>Wir melden uns in Kürze mit den nächsten Schritten.</p>`,
  body_text: `Sehr geehrte/r {{customer_name}},

hiermit bestätigen wir, dass das Angebot {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}} angenommen wurde. Gesamtbetrag: {{total_amount}}.
{{#if accepted_on_behalf}}
Diese Bestätigung wurde stellvertretend durch Ihren Fotografen erfasst. Falls etwas unklar ist, antworten Sie bitte direkt auf diese E-Mail.
{{/if}}
Wir melden uns in Kürze mit den nächsten Schritten.`,
};

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  const existing = await knex('email_templates')
    .where({ template_key: 'quote_accepted_customer' })
    .first();
  if (existing) return;

  // The email_templates schema stores per-locale rows. Mirrors the
  // shape used by migration 102 for the other quote_* templates.
  const rows = [
    {
      template_key: 'quote_accepted_customer',
      language: 'en',
      subject: EN.subject,
      body_html: EN.body_html,
      body_text: EN.body_text,
      category: 'quotes',
      feature_flag: 'quotes',
      created_at: new Date(),
      updated_at: new Date(),
    },
    {
      template_key: 'quote_accepted_customer',
      language: 'de',
      subject: DE.subject,
      body_html: DE.body_html,
      body_text: DE.body_text,
      category: 'quotes',
      feature_flag: 'quotes',
      created_at: new Date(),
      updated_at: new Date(),
    },
  ];
  await knex('email_templates').insert(rows);
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').where({ template_key: 'quote_accepted_customer' }).del();
};

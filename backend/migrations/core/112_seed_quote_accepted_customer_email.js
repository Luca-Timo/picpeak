/**
 * Migration: seed `quote_accepted_customer` email template
 *
 * Migration 102 seeded admin-facing templates (quote_accepted_admin,
 * quote_declined_admin) but no customer-facing confirmation. This
 * adds one so the customer receives a paper trail (with the rendered
 * quote PDF attached) when their quote is accepted — whether they
 * clicked Accept on the public response page themselves OR the admin
 * recorded acceptance on their behalf (phone-call workflow).
 *
 * One template covers both paths via a conditional snippet: when
 * `accepted_on_behalf` is truthy in the substitution context, an
 * extra paragraph tells the customer that the acceptance was
 * recorded by the photographer.
 *
 * Schema note: `email_templates` uses per-language COLUMNS
 * (`subject_en`, `subject_de`, `body_html_en`, ...), NOT per-language
 * rows. Translations also live in `email_template_translations` when
 * that table is present. We introspect both at runtime so the
 * migration is forward-compatible across the two shapes that have
 * shipped over time. Same pattern migration 102 uses.
 *
 * Idempotent — skipped when the template_key already exists.
 */

const TEMPLATE = {
  category: 'quotes',
  feature_flag: 'quotes',
  variables: ['customer_name', 'quote_number', 'event_name', 'total_amount', 'accepted_on_behalf'],
  en: {
    subject: 'Quote {{quote_number}} accepted — thank you',
    body_html: `<h2>Thank you</h2>
<p>Dear {{customer_name}},</p>
<p>This confirms that quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}} has been accepted. Total: <strong>{{total_amount}}</strong>.</p>
{{#if accepted_on_behalf}}<p style="font-size: 13px; color: #666;">This acceptance was recorded on your behalf by your photographer.</p>{{/if}}
<p>We'll be in touch with next steps shortly.</p>`,
    body_text: `Dear {{customer_name}},

This confirms that quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}} has been accepted. Total: {{total_amount}}.
{{#if accepted_on_behalf}}
This acceptance was recorded on your behalf by your photographer.
{{/if}}
We'll be in touch with next steps shortly.`,
  },
  de: {
    subject: 'Angebot {{quote_number}} angenommen — vielen Dank',
    body_html: `<h2>Vielen Dank</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>hiermit bestätigen wir, dass das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für „{{event_name}}"{{/if}} angenommen wurde. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>
{{#if accepted_on_behalf}}<p style="font-size: 13px; color: #666;">Diese Bestätigung wurde stellvertretend durch Ihren Fotografen erfasst.</p>{{/if}}
<p>Wir melden uns in Kürze mit den nächsten Schritten.</p>`,
    body_text: `Sehr geehrte/r {{customer_name}},

hiermit bestätigen wir, dass das Angebot {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}} angenommen wurde. Gesamtbetrag: {{total_amount}}.
{{#if accepted_on_behalf}}
Diese Bestätigung wurde stellvertretend durch Ihren Fotografen erfasst.
{{/if}}
Wir melden uns in Kürze mit den nächsten Schritten.`,
  },
};

const TEMPLATE_KEY = 'quote_accepted_customer';

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  const existing = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (existing) return;

  // Introspect the live column set — different deployments shipped
  // with slightly different shapes (some still have the legacy
  // `subject` / `body_html` / `body_text` columns from before 059
  // turned them per-language; others have only `subject_en` /
  // `subject_de`). We fill whichever ones are there so the row is
  // valid on both shapes.
  const cols = await knex('email_templates').columnInfo();
  const enContent = TEMPLATE.en;

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
      row[colName] = enContent.subject;
    } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
      row[colName] = enContent.body_html;
    } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
      row[colName] = enContent.body_text;
    }
  }
  // After the loop fill the de-specific columns when they exist —
  // the loop above already wrote them with the EN content because
  // every regex matched; overwrite with the actual DE strings.
  if ('subject_de' in cols)   row.subject_de   = TEMPLATE.de.subject;
  if ('body_html_de' in cols) row.body_html_de = TEMPLATE.de.body_html;
  if ('body_text_de' in cols) row.body_text_de = TEMPLATE.de.body_text;

  const inserted = await knex('email_templates').insert(row).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  // If the install carries the per-language translations table,
  // also seed both rows there. Failure here is non-fatal — the
  // per-column shape above is the canonical store on most installs.
  const hasTranslationsTable = await knex.schema.hasTable('email_template_translations');
  if (hasTranslationsTable && templateId) {
    for (const lang of ['en', 'de']) {
      const content = TEMPLATE[lang];
      if (!content) continue;
      try {
        await knex('email_template_translations').insert({
          template_id: templateId,
          language: lang,
          subject: content.subject,
          body_html: content.body_html,
          body_text: content.body_text,
          created_at: new Date(),
          updated_at: new Date(),
        });
      } catch (_) { /* ignore — some shapes lack created/updated cols */ }
    }
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  // Cascade to translations if the FK isn't set up.
  if (await knex.schema.hasTable('email_template_translations')) {
    const row = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
    if (row?.id) {
      await knex('email_template_translations').where({ template_id: row.id }).del();
    }
  }
  await knex('email_templates').where({ template_key: TEMPLATE_KEY }).del();
};

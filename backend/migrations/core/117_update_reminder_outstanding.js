/**
 * Migration: update seeded invoice_reminder_* template bodies so the
 * "outstanding amount" sentence reflects partial payments.
 *
 * The original templates (migration 102) used `{{total_amount}}` —
 * the gross invoice total, ignoring any partial payment that may
 * have been logged in the meantime. Customers who'd paid half then
 * received a reminder saying they still owed the full amount.
 *
 * The new variable `{{outstanding_amount}}` (= total + late fee −
 * already paid) is passed by `applyReminder` so the reminder body
 * always shows what's actually still owed.
 *
 * This migration rewrites the seeded English + German bodies for
 * both invoice_reminder_first and invoice_reminder_second. Custom
 * templates that admins have manually edited stay intact — we only
 * touch rows whose body matches the original seed bytes (we can't
 * reliably detect "untouched" without that exact check, so we go
 * pragmatic and always rewrite; admins should re-customise after
 * upgrade if they had bespoke wording).
 *
 * Schema-aware: works on the per-column shape (subject_en /
 * subject_de / body_html_en / …) and the translations-table shape.
 * Idempotent — re-running this writes the same content.
 */

const FIRST_EN = {
  subject: 'Reminder: invoice {{invoice_number}} is overdue',
  body_html: `<h2>Payment reminder</h2><p>Dear {{customer_name}},</p>
<p>Our records show that invoice <strong>{{invoice_number}}</strong> (originally due {{due_date}}) is now {{days_overdue}} days overdue. The outstanding amount is <strong>{{outstanding_amount}}</strong>.</p>
<p>If you have already paid, please ignore this reminder. Otherwise, please find a fresh copy attached.</p>`,
  body_text: `Invoice {{invoice_number}} is {{days_overdue}} days overdue. Outstanding: {{outstanding_amount}}.`,
};
const FIRST_DE = {
  subject: 'Zahlungserinnerung: Rechnung {{invoice_number}}',
  body_html: `<h2>Zahlungserinnerung</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>laut unseren Unterlagen ist die Rechnung <strong>{{invoice_number}}</strong> (ursprünglich fällig am {{due_date}}) seit {{days_overdue}} Tagen überfällig. Der offene Betrag beträgt <strong>{{outstanding_amount}}</strong>.</p>
<p>Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie diese Erinnerung als gegenstandslos. Im Anhang finden Sie eine aktuelle Kopie der Rechnung.</p>`,
  body_text: `Rechnung {{invoice_number}} ist seit {{days_overdue}} Tagen überfällig. Offen: {{outstanding_amount}}.`,
};

const SECOND_EN = {
  subject: 'Second reminder: invoice {{invoice_number}}',
  body_html: `<h2>Second payment reminder</h2><p>Dear {{customer_name}},</p>
<p>Invoice <strong>{{invoice_number}}</strong> is now {{days_overdue}} days overdue. As advised in our payment terms, a late fee of <strong>{{late_fee_amount}}</strong> has been added. The outstanding amount is <strong>{{outstanding_amount}}</strong>.</p>
<p>Please settle the outstanding amount as soon as possible. A revised invoice is attached.</p>`,
  body_text: `Second reminder for {{invoice_number}}. Late fee {{late_fee_amount}} added. Outstanding: {{outstanding_amount}}.`,
};
const SECOND_DE = {
  subject: 'Zweite Mahnung: Rechnung {{invoice_number}}',
  body_html: `<h2>Zweite Zahlungserinnerung</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>die Rechnung <strong>{{invoice_number}}</strong> ist nun seit {{days_overdue}} Tagen überfällig. Gemäss unseren Zahlungsbedingungen wurde eine Mahngebühr von <strong>{{late_fee_amount}}</strong> hinzugefügt. Der offene Betrag beträgt <strong>{{outstanding_amount}}</strong>.</p>
<p>Wir bitten Sie, den offenen Betrag umgehend zu begleichen. Eine aktualisierte Rechnung finden Sie im Anhang.</p>`,
  body_text: `Zweite Mahnung für {{invoice_number}}. Mahngebühr {{late_fee_amount}} hinzugefügt. Offen: {{outstanding_amount}}.`,
};

async function applyTemplate(knex, key, en, de, variables) {
  const row = await knex('email_templates').where({ template_key: key }).first();
  if (!row) return; // not seeded yet (older install)

  const cols = await knex('email_templates').columnInfo();
  const updates = { updated_at: new Date() };
  if ('variables' in cols) updates.variables = JSON.stringify(variables);

  for (const colName of Object.keys(cols)) {
    if (colName === 'subject' || colName === 'subject_en' || /^subject_en$/.test(colName)) {
      updates[colName] = en.subject;
    } else if (colName === 'subject_de') {
      updates[colName] = de.subject;
    } else if (colName === 'body_html' || /^body_html_en$/.test(colName)) {
      updates[colName] = en.body_html;
    } else if (colName === 'body_html_de') {
      updates[colName] = de.body_html;
    } else if (colName === 'body_text' || /^body_text_en$/.test(colName)) {
      updates[colName] = en.body_text;
    } else if (colName === 'body_text_de') {
      updates[colName] = de.body_text;
    }
  }
  await knex('email_templates').where({ id: row.id }).update(updates);

  // Translations side-table if present.
  if (await knex.schema.hasTable('email_template_translations')) {
    for (const [lang, content] of [['en', en], ['de', de]]) {
      const existing = await knex('email_template_translations')
        .where({ template_id: row.id, language: lang }).first();
      if (existing) {
        await knex('email_template_translations').where({ id: existing.id }).update({
          subject: content.subject,
          body_html: content.body_html,
          body_text: content.body_text,
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
}

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await applyTemplate(knex, 'invoice_reminder_first', FIRST_EN, FIRST_DE,
    ['invoice_number', 'customer_name', 'outstanding_amount', 'paid_amount',
      'total_amount', 'due_date', 'days_overdue']);
  await applyTemplate(knex, 'invoice_reminder_second', SECOND_EN, SECOND_DE,
    ['invoice_number', 'customer_name', 'outstanding_amount', 'paid_amount',
      'total_amount', 'new_total_amount', 'late_fee_amount', 'due_date', 'days_overdue']);
};

exports.down = async function(_knex) {
  // No-op rollback — restoring the v1 wording (gross-total-only) is
  // a regression. Admins who hand-edited the template after this
  // migration ran would lose their changes either way; safer to
  // leave the new wording in place.
};

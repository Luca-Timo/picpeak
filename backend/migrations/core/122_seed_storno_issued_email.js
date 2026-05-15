/**
 * Migration: replace dormant `invoice_cancelled` email template with
 * `storno_issued` — the legally-required cancellation-document
 * notification sent automatically by invoiceService.sendStorno().
 *
 * Why a new template (vs. editing 102 in place):
 *   - Migration 102 is on beta + main; per the maintainer's standing
 *     rule, deployed migrations stay frozen and corrections ship as
 *     their own migration.
 *   - The original `invoice_cancelled` template was seeded but never
 *     wired up (no caller queued it). It carried the wrong shape for
 *     the new flow anyway: no Storno number, no reference to the
 *     original document, no absolute total amount. Safe to drop and
 *     replace.
 *
 * Locales:
 *   - en + de: hand-translated.
 *   - fr / nl / pt / ru: machine translations. PR description should
 *     flag these for native review (maintainer speaks de + en only;
 *     other locale strings need a second pair of eyes before they
 *     hit production).
 *
 * Variables the renderer expects (filled in by sendStorno()):
 *   storno_number, original_invoice_number, original_issue_date,
 *   customer_name, total_amount.
 *
 * Idempotent.
 */

const OLD_KEY = 'invoice_cancelled';
const NEW_KEY = 'storno_issued';

const EN = {
  subject: 'Cancellation invoice {{storno_number}} for invoice {{original_invoice_number}}',
  body_html: `<p>Dear {{customer_name}},</p>
<p>Please find attached cancellation invoice <strong>{{storno_number}}</strong>, which formally reverses invoice <strong>{{original_invoice_number}}</strong> dated {{original_issue_date}} for {{total_amount}}.</p>
<p>The original invoice is no longer payable. Please retain the attached PDF for your records and disregard any prior reminders.</p>`,
  body_text: `Cancellation invoice {{storno_number}} formally reverses invoice {{original_invoice_number}} dated {{original_issue_date}} for {{total_amount}}. The original invoice is no longer payable. PDF attached.`,
};

const DE = {
  subject: 'Stornorechnung {{storno_number}} zu Rechnung {{original_invoice_number}}',
  body_html: `<p>Sehr geehrte/r {{customer_name}},</p>
<p>anbei erhalten Sie die Stornorechnung <strong>{{storno_number}}</strong>, mit der die Rechnung <strong>{{original_invoice_number}}</strong> vom {{original_issue_date}} über {{total_amount}} förmlich aufgehoben wird.</p>
<p>Die ursprüngliche Rechnung ist damit nicht mehr zu begleichen. Bitte bewahren Sie die beigefügte PDF für Ihre Unterlagen auf — etwaige vorherige Mahnungen sind hinfällig.</p>`,
  body_text: `Stornorechnung {{storno_number}} hebt Rechnung {{original_invoice_number}} vom {{original_issue_date}} über {{total_amount}} förmlich auf. Die ursprüngliche Rechnung ist nicht mehr zu begleichen. PDF im Anhang.`,
};

// --- machine translations (flag for native review in PR) ---------------
const FR = {
  subject: 'Avoir {{storno_number}} pour la facture {{original_invoice_number}}',
  body_html: `<p>Bonjour {{customer_name}},</p>
<p>Veuillez trouver ci-joint l'avoir <strong>{{storno_number}}</strong>, qui annule formellement la facture <strong>{{original_invoice_number}}</strong> du {{original_issue_date}} d'un montant de {{total_amount}}.</p>
<p>La facture initiale n'est plus due. Merci de conserver le PDF joint pour vos dossiers ; toute relance antérieure est sans objet.</p>`,
  body_text: `Avoir {{storno_number}} annule formellement la facture {{original_invoice_number}} du {{original_issue_date}} d'un montant de {{total_amount}}. La facture initiale n'est plus due. PDF joint.`,
};

const NL = {
  subject: 'Creditfactuur {{storno_number}} voor factuur {{original_invoice_number}}',
  body_html: `<p>Geachte {{customer_name}},</p>
<p>Bijgevoegd vindt u creditfactuur <strong>{{storno_number}}</strong>, waarmee factuur <strong>{{original_invoice_number}}</strong> van {{original_issue_date}} ter waarde van {{total_amount}} formeel wordt geannuleerd.</p>
<p>De oorspronkelijke factuur hoeft niet langer te worden voldaan. Bewaar de bijgevoegde PDF voor uw administratie; eerdere herinneringen zijn niet meer van toepassing.</p>`,
  body_text: `Creditfactuur {{storno_number}} annuleert factuur {{original_invoice_number}} van {{original_issue_date}} ter waarde van {{total_amount}}. De oorspronkelijke factuur hoeft niet langer te worden voldaan. PDF bijgevoegd.`,
};

const PT = {
  subject: 'Nota de crédito {{storno_number}} para a fatura {{original_invoice_number}}',
  body_html: `<p>Prezado(a) {{customer_name}},</p>
<p>Segue em anexo a nota de crédito <strong>{{storno_number}}</strong>, que cancela formalmente a fatura <strong>{{original_invoice_number}}</strong> de {{original_issue_date}} no valor de {{total_amount}}.</p>
<p>A fatura original não é mais devida. Por favor, guarde o PDF anexo para os seus registos; eventuais lembretes anteriores ficam sem efeito.</p>`,
  body_text: `Nota de crédito {{storno_number}} cancela formalmente a fatura {{original_invoice_number}} de {{original_issue_date}} no valor de {{total_amount}}. A fatura original não é mais devida. PDF em anexo.`,
};

const RU = {
  subject: 'Сторно-счёт {{storno_number}} к счёту {{original_invoice_number}}',
  body_html: `<p>Уважаемый(ая) {{customer_name}},</p>
<p>Во вложении сторно-счёт <strong>{{storno_number}}</strong>, формально отменяющий счёт <strong>{{original_invoice_number}}</strong> от {{original_issue_date}} на сумму {{total_amount}}.</p>
<p>Исходный счёт оплате не подлежит. Просим сохранить вложенный PDF для своих записей; ранее отправленные напоминания утратили силу.</p>`,
  body_text: `Сторно-счёт {{storno_number}} формально отменяет счёт {{original_invoice_number}} от {{original_issue_date}} на сумму {{total_amount}}. Исходный счёт оплате не подлежит. PDF во вложении.`,
};

const TEMPLATE = {
  category: 'billing',
  feature_flag: 'bills',
  variables: ['storno_number', 'original_invoice_number', 'original_issue_date',
    'customer_name', 'total_amount'],
  en: EN, de: DE, fr: FR, nl: NL, pt: PT, ru: RU,
};

const LOCALES = ['en', 'de', 'fr', 'nl', 'pt', 'ru'];

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  // Idempotent guard — if the new template already exists, leave it
  // alone (admin may have customised it).
  const already = await knex('email_templates').where({ template_key: NEW_KEY }).first();
  if (already) return;

  // Best-effort cleanup of the dormant legacy template. It was never
  // queued by any caller, so dropping it doesn't risk losing admin
  // customisations. If an admin somehow did edit it, the customised
  // copy is preserved as `${OLD_KEY}_legacy` so it's recoverable.
  const legacy = await knex('email_templates').where({ template_key: OLD_KEY }).first();
  if (legacy?.id) {
    const archiveKey = `${OLD_KEY}_legacy`;
    const archivedExists = await knex('email_templates').where({ template_key: archiveKey }).first();
    if (!archivedExists) {
      await knex('email_templates').where({ id: legacy.id }).update({
        template_key: archiveKey,
        updated_at: new Date(),
      });
    } else {
      // Already archived once (re-run). Drop the duplicate row + its
      // translations entirely.
      if (await knex.schema.hasTable('email_template_translations')) {
        await knex('email_template_translations').where({ template_id: legacy.id }).del();
      }
      await knex('email_templates').where({ id: legacy.id }).del();
    }
  }

  const cols = await knex('email_templates').columnInfo();
  const row = {
    template_key: NEW_KEY,
    variables: JSON.stringify(TEMPLATE.variables),
  };
  if ('category' in cols)     row.category = TEMPLATE.category;
  if ('subcategory' in cols)  row.subcategory = null;
  if ('feature_flag' in cols) row.feature_flag = TEMPLATE.feature_flag;
  if ('created_at' in cols)   row.created_at = new Date();
  if ('updated_at' in cols)   row.updated_at = new Date();

  // Master row carries the English defaults across the
  // legacy single-locale columns (subject / body_html / body_text),
  // plus any matching _de / _fr / etc. columns the installation has.
  // Mirrors migrations 102 + 116.
  for (const colName of Object.keys(cols)) {
    if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
      const m = colName.match(/_([a-z]{2,3})$/);
      const lang = m ? m[1] : 'en';
      const content = TEMPLATE[lang] || EN;
      row[colName] = content.subject;
    } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
      const m = colName.match(/_([a-z]{2,3})$/);
      const lang = m ? m[1] : 'en';
      const content = TEMPLATE[lang] || EN;
      row[colName] = content.body_html;
    } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
      const m = colName.match(/_([a-z]{2,3})$/);
      const lang = m ? m[1] : 'en';
      const content = TEMPLATE[lang] || EN;
      row[colName] = content.body_text;
    }
  }

  const inserted = await knex('email_templates').insert(row).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (await knex.schema.hasTable('email_template_translations') && templateId) {
    for (const lang of LOCALES) {
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
      } catch (_) { /* ignore — schema variance across installs */ }
    }
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (await knex.schema.hasTable('email_template_translations')) {
    const row = await knex('email_templates').where({ template_key: NEW_KEY }).first();
    if (row?.id) {
      await knex('email_template_translations').where({ template_id: row.id }).del();
    }
  }
  await knex('email_templates').where({ template_key: NEW_KEY }).del();
  // Restore the archived legacy row if present.
  await knex('email_templates').where({ template_key: `${OLD_KEY}_legacy` }).update({
    template_key: OLD_KEY,
    updated_at: new Date(),
  });
};

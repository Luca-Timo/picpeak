'use strict';

/**
 * Bring a seeded email template up to date when its default text changed.
 *
 * A stored template still identical to its previous default (`previousDefaults`,
 * keyed like `templates`, en + de) gets the current default; one an admin has
 * edited is left as it is. Matches on the full subject + body, so a single
 * edited field keeps the whole language untouched. Used by the seeders whose
 * defaults changed after they shipped (crmEmailTemplates, galleryDeliveryTemplates).
 */
async function upgradeUneditedTemplates(db, { templates, previousDefaults, cols, hasTranslationsTable, logger }) {
  for (const [templateKey, previous] of Object.entries(previousDefaults)) {
    const def = templates[templateKey];
    const row = await db('email_templates').where({ template_key: templateKey }).first();
    if (!row) continue;
    let upgraded = false;
    if (hasTranslationsTable) {
      for (const lang of ['en', 'de']) {
        const old = previous[lang];
        const next = def[lang];
        if (!old || !next) continue;
        const updated = await db('email_template_translations')
          .where({ template_id: row.id, language: lang, subject: old.subject, body_html: old.body_html, body_text: old.body_text })
          .update({ subject: next.subject, body_html: next.body_html, body_text: next.body_text, updated_at: new Date() });
        if (updated) upgraded = true;
      }
    }
    const legacy = {};
    for (const field of ['subject', 'body_html', 'body_text']) {
      for (const colName of Object.keys(cols)) {
        if ((colName === field || colName === `${field}_en`) && row[colName] === previous.en[field]) legacy[colName] = def.en[field];
        if (colName === `${field}_de` && previous.de && row[colName] === previous.de[field]) legacy[colName] = def.de[field];
      }
    }
    if (Object.keys(legacy).length) {
      await db('email_templates').where({ id: row.id }).update(legacy);
      upgraded = true;
    }
    if (upgraded) {
      await db('email_templates').where({ id: row.id }).update({ variables: JSON.stringify(def.variables) });
      if (logger) logger.info(`Updated the unedited default email template: ${templateKey}`);
    }
  }
}

module.exports = { upgradeUneditedTemplates };

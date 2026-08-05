/**
 * Migration 172: reword the recipient `transfer_ready` email (follow-up to 171).
 *
 * Two fixes to the copy seeded in 171:
 *   1. Warmer, less robotic wording (greeting + natural phrasing + friendly
 *      sign-off) instead of the terse "has been shared with you" notice.
 *   2. The message block is wrapped in `{{#if message}}` so a transfer sent
 *      WITHOUT a personal note no longer renders an empty coloured box (the
 *      "grey bar" some clients showed for the always-present empty <div>).
 *
 * This is a content UPDATE rather than an edit to 171 because 171 has already
 * been applied on existing installs — Knex won't re-run it, so the seeded row
 * would otherwise keep the old copy. UPDATE reaches both existing rows and
 * fresh installs (which run 171's insert first, then this).
 */

const HTML_EN = `
<h2>Your files are ready</h2>

<p>Hi,</p>

<p>{{transfer_title}} is ready for you — you can grab everything with a single click below.</p>

{{#if message}}
<div style="background-color: #f6f6f4; border-left: 4px solid #5C8762; padding: 16px 20px; margin: 20px 0; border-radius: 4px; white-space: pre-line;">{{message}}</div>
{{/if}}

<p style="margin: 28px 0;">
  <a href="{{download_url}}" style="background-color: #5C8762; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Download your files</a>
</p>

<p style="color: #555555;">The link stays active until {{expiry_date}} and includes {{file_count}} file(s).</p>

<p style="color: #999999; font-size: 13px;">Button not working? Just copy this link into your browser:<br>{{download_url}}</p>

<p>Enjoy your photos!</p>`;

const TEXT_EN = `Your files are ready

Hi,

{{transfer_title}} is ready for you — grab everything with the link below.
{{#if message}}

{{message}}
{{/if}}

Download your files:
{{download_url}}

The link stays active until {{expiry_date}} and includes {{file_count}} file(s).

Enjoy your photos!`;

const HTML_DE = `
<h2>Ihre Dateien sind bereit</h2>

<p>Hallo,</p>

<p>{{transfer_title}} ist für Sie bereit — mit einem Klick unten können Sie alles herunterladen.</p>

{{#if message}}
<div style="background-color: #f6f6f4; border-left: 4px solid #5C8762; padding: 16px 20px; margin: 20px 0; border-radius: 4px; white-space: pre-line;">{{message}}</div>
{{/if}}

<p style="margin: 28px 0;">
  <a href="{{download_url}}" style="background-color: #5C8762; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Dateien herunterladen</a>
</p>

<p style="color: #555555;">Der Link ist bis zum {{expiry_date}} gültig und enthält {{file_count}} Datei(en).</p>

<p style="color: #999999; font-size: 13px;">Funktioniert die Schaltfläche nicht? Kopieren Sie einfach diesen Link in Ihren Browser:<br>{{download_url}}</p>

<p>Viel Freude mit Ihren Fotos!</p>`;

const TEXT_DE = `Ihre Dateien sind bereit

Hallo,

{{transfer_title}} ist für Sie bereit — laden Sie alles über den Link unten herunter.
{{#if message}}

{{message}}
{{/if}}

Dateien herunterladen:
{{download_url}}

Der Link ist bis zum {{expiry_date}} gültig und enthält {{file_count}} Datei(en).

Viel Freude mit Ihren Fotos!`;

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates')
    .where('template_key', 'transfer_ready')
    .update({
      subject_en: '{{transfer_title}} — your files are ready to download',
      subject_de: '{{transfer_title}} — Ihre Dateien stehen bereit',
      body_html_en: HTML_EN,
      body_text_en: TEXT_EN,
      body_html_de: HTML_DE,
      body_text_de: TEXT_DE,
    });
};

// Content-only refresh — nothing structural to reverse. The previous copy is
// preserved in migration 171's insert for reference.
exports.down = async function () {};

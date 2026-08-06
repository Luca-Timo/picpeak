/**
 * Migration 171: PicTransfer — admin-uploaded deliverable files + email delivery
 * (follow-up to #997).
 *
 * 170 shipped the base feature; this adds two things the create flow now needs:
 *
 *   transfer_extra_files  Files the ADMIN uploads straight into a transfer at
 *                         creation (or later), stored as the transfer's own
 *                         bytes under `transfers/{id}/files/…`. Unlike
 *                         transfer_files (which reference gallery `photos`),
 *                         these have no event/photo — they are the operator's
 *                         own attachments and are part of the recipient's
 *                         download alongside the picked event photos. Deleted
 *                         with the transfer (retention sweep / hard delete).
 *   transfer_recipients   When a transfer is delivered by email, the recipient
 *                         address(es) it was sent to (audit + "sent to …" in the
 *                         detail panel). CASCADE with the transfer.
 *
 * Plus `transfers.delivery_method` ('link' | 'email', default 'link') and a
 * recipient-facing `transfer_ready` email template (EN/DE).
 *
 * 170 is already applied on existing installs, so this is a separate, additive
 * migration (Knex won't re-run 170). Fully guarded + idempotent.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('transfer_extra_files'))) {
    await knex.schema.createTable('transfer_extra_files', (table) => {
      table.increments('id').primary();
      table.integer('transfer_id').unsigned().notNullable()
        .references('id').inTable('transfers').onDelete('CASCADE');
      table.string('original_filename', 512).notNullable();
      // Storage-relative key, e.g. transfers/{id}/files/{stored-name}.
      table.string('stored_path', 1024).notNullable();
      table.integer('size_bytes');
      table.string('mime_type', 100);
      table.integer('sort_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.index(['transfer_id'], 'transfer_extra_files_transfer_idx');
    });
  }

  if (!(await knex.schema.hasTable('transfer_recipients'))) {
    await knex.schema.createTable('transfer_recipients', (table) => {
      table.increments('id').primary();
      table.integer('transfer_id').unsigned().notNullable()
        .references('id').inTable('transfers').onDelete('CASCADE');
      table.string('email', 320).notNullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('last_sent_at');
      table.index(['transfer_id'], 'transfer_recipients_transfer_idx');
    });
  }

  const hasDeliveryMethod = await knex.schema.hasColumn('transfers', 'delivery_method');
  if (!hasDeliveryMethod) {
    await knex.schema.alterTable('transfers', (table) => {
      // 'link' (default — the operator copies/shares the link themselves) or
      // 'email' (PicPeak emailed the download link to transfer_recipients).
      table.string('delivery_method', 10).notNullable().defaultTo('link');
    });
  }

  // Recipient-facing "your files are ready" email (EN + DE), sent when a
  // transfer is created with delivery_method='email'. Mirrors the convention
  // of the existing transfer_link_expired admin template (migration 170).
  const existingTemplate = await knex('email_templates')
    .where('template_key', 'transfer_ready')
    .first();
  if (!existingTemplate) {
    await knex('email_templates').insert({
      template_key: 'transfer_ready',
      subject_en: 'Your files are ready — {{transfer_title}}',
      subject_de: 'Ihre Dateien sind bereit — {{transfer_title}}',
      body_html_en: `
<h2>Your files are ready</h2>

<p>{{transfer_title}} has been shared with you.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;">{{message}}</p>
</div>

<p style="margin: 24px 0;">
  <a href="{{download_url}}" class="button">Download your files</a>
</p>

<p><strong>Files:</strong> {{file_count}}<br>
<strong>Available until:</strong> {{expiry_date}}</p>

<p style="color: #888; font-size: 13px;">If the button doesn't work, copy this link into your browser:<br>{{download_url}}</p>

<p>Best regards,<br>
Your PicPeak Installation</p>`,
      body_text_en: `Your files are ready

{{transfer_title}} has been shared with you.

{{message}}

Download your files: {{download_url}}

Files: {{file_count}}
Available until: {{expiry_date}}

Best regards,
Your PicPeak Installation`,
      body_html_de: `
<h2>Ihre Dateien sind bereit</h2>

<p>{{transfer_title}} wurde mit Ihnen geteilt.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;">{{message}}</p>
</div>

<p style="margin: 24px 0;">
  <a href="{{download_url}}" class="button">Dateien herunterladen</a>
</p>

<p><strong>Dateien:</strong> {{file_count}}<br>
<strong>Verfügbar bis:</strong> {{expiry_date}}</p>

<p style="color: #888; font-size: 13px;">Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:<br>{{download_url}}</p>

<p>Mit freundlichen Grüßen,<br>
Ihre PicPeak-Installation</p>`,
      body_text_de: `Ihre Dateien sind bereit

{{transfer_title}} wurde mit Ihnen geteilt.

{{message}}

Dateien herunterladen: {{download_url}}

Dateien: {{file_count}}
Verfügbar bis: {{expiry_date}}

Mit freundlichen Grüßen,
Ihre PicPeak-Installation`,
      variables: JSON.stringify([
        'transfer_title', 'message', 'download_url', 'file_count', 'expiry_date',
      ]),
    });
  }
};

exports.down = async function (knex) {
  await knex('email_templates').where('template_key', 'transfer_ready').del();
  if (await knex.schema.hasColumn('transfers', 'delivery_method')) {
    await knex.schema.alterTable('transfers', (table) => {
      table.dropColumn('delivery_method');
    });
  }
  await knex.schema.dropTableIfExists('transfer_recipients');
  await knex.schema.dropTableIfExists('transfer_extra_files');
};

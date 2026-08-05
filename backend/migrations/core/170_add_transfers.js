/**
 * Migration 170: PicTransfer — cross-event file transfers (#997).
 *
 * Adds the tables that back the "send these files to someone" feature:
 *
 *   transfers          One share link. Bundles photos picked from ANY event,
 *                      protected by a 64-hex recipient token. Optionally opens
 *                      a 6-char upload token so the client can send files back
 *                      (logos etc.). Disabled after `expires_at`; files are
 *                      kept `grace_days` days past disable, then hard-deleted.
 *   transfer_files     Join rows: which photos are in a transfer (cross-event).
 *                      photo_id → photos CASCADE, so removing the underlying
 *                      photo just drops it from the transfer; the reverse
 *                      (deleting a transfer) never touches the source photos.
 *   transfer_uploads   Files the client uploaded through the upload token.
 *                      These have their own bytes on disk (uploads/transfers/…)
 *                      and are what the retention sweep deletes.
 *   transfer_downloads Lightweight audit of recipient downloads (count + IP).
 *
 * Downloads always serve ORIGINAL files (never watermarked) — a transfer is a
 * deliberate "here are your files" hand-off. Reuses the same original-file
 * resolution + archiver streaming as the gallery download-all path.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('transfers'))) {
    await knex.schema.createTable('transfers', (table) => {
      table.increments('id').primary();
      // Recipient download token — 64 hex chars = 32 bytes = 256 bits.
      table.string('token', 64).notNullable().unique();
      table.string('title', 255).notNullable().defaultTo('');
      table.text('message');
      table.integer('created_by').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      // Link is disabled once this passes (the "set time period" cap).
      table.timestamp('expires_at').notNullable();
      // Optional download cap. NULL or 0 = unlimited within the window.
      table.integer('max_downloads');
      table.integer('download_count').notNullable().defaultTo(0);
      table.boolean('is_active').notNullable().defaultTo(true);
      // When the link flipped inactive — starts the retention clock.
      table.timestamp('disabled_at');
      // Keep files this many days after disable, then hard-delete.
      table.integer('grace_days').notNullable().defaultTo(7);
      table.timestamp('admin_notified_at');
      table.timestamp('deleted_at');
      // Optional client-upload channel (6-char token).
      table.boolean('allow_uploads').notNullable().defaultTo(false);
      table.string('upload_token', 16).unique();
      table.timestamp('upload_expires_at');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['is_active', 'expires_at'], 'transfers_active_expiry_idx');
      table.index(['deleted_at'], 'transfers_deleted_idx');
    });
  }

  if (!(await knex.schema.hasTable('transfer_files'))) {
    await knex.schema.createTable('transfer_files', (table) => {
      table.increments('id').primary();
      table.integer('transfer_id').unsigned().notNullable()
        .references('id').inTable('transfers').onDelete('CASCADE');
      table.integer('photo_id').unsigned().notNullable()
        .references('id').inTable('photos').onDelete('CASCADE');
      table.integer('sort_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.index(['transfer_id'], 'transfer_files_transfer_idx');
      // A photo can only appear once per transfer.
      table.unique(['transfer_id', 'photo_id'], 'transfer_files_unique');
    });
  }

  if (!(await knex.schema.hasTable('transfer_uploads'))) {
    await knex.schema.createTable('transfer_uploads', (table) => {
      table.increments('id').primary();
      table.integer('transfer_id').unsigned().notNullable()
        .references('id').inTable('transfers').onDelete('CASCADE');
      table.string('original_filename', 512).notNullable();
      // Storage-relative key, e.g. uploads/transfers/{id}/{stored-name}.
      table.string('stored_path', 1024).notNullable();
      table.integer('size_bytes');
      table.string('mime_type', 100);
      table.string('uploader_ip', 45);
      table.timestamp('uploaded_at').defaultTo(knex.fn.now());
      table.index(['transfer_id'], 'transfer_uploads_transfer_idx');
    });
  }

  if (!(await knex.schema.hasTable('transfer_downloads'))) {
    await knex.schema.createTable('transfer_downloads', (table) => {
      table.increments('id').primary();
      table.integer('transfer_id').unsigned().notNullable()
        .references('id').inTable('transfers').onDelete('CASCADE');
      table.string('kind', 20).notNullable().defaultTo('all'); // 'all' | 'single'
      table.integer('photo_id').unsigned();
      table.string('ip', 45);
      table.timestamp('downloaded_at').defaultTo(knex.fn.now());
      table.index(['transfer_id'], 'transfer_downloads_transfer_idx');
    });
  }

  // Defaults for the create-transfer form + retention/upload behaviour.
  const settings = [
    { setting_key: 'transfer_default_expiry_days', setting_value: JSON.stringify(14), setting_type: 'number' },
    { setting_key: 'transfer_default_grace_days', setting_value: JSON.stringify(7), setting_type: 'number' },
    { setting_key: 'transfer_default_max_downloads', setting_value: JSON.stringify(0), setting_type: 'number' },
    { setting_key: 'transfer_max_upload_size_mb', setting_value: JSON.stringify(50), setting_type: 'number' },
    {
      setting_key: 'transfer_upload_allowed_mime',
      setting_value: JSON.stringify([
        'image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'image/tiff', 'application/pdf', 'application/zip',
      ]),
      setting_type: 'general',
    },
  ];
  for (const s of settings) {
    const exists = await knex('app_settings').where('setting_key', s.setting_key).first();
    if (!exists) {
      await knex('app_settings').insert({ ...s, updated_at: knex.fn.now() });
    }
  }

  // Admin notification when a transfer link expires (EN + DE, matching the
  // convention of the other admin-notification templates — see migration 087).
  const existingTemplate = await knex('email_templates')
    .where('template_key', 'transfer_link_expired')
    .first();
  if (!existingTemplate) {
    await knex('email_templates').insert({
      template_key: 'transfer_link_expired',
      subject_en: 'A transfer link has expired — {{transfer_title}}',
      subject_de: 'Ein Transfer-Link ist abgelaufen — {{transfer_title}}',
      body_html_en: `
<h2>A transfer link has expired</h2>

<p>The following file transfer is no longer downloadable by its recipient:</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Transfer:</strong> {{transfer_title}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Expired at:</strong> {{expiry_date}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Files included:</strong> {{file_count}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Client uploads received:</strong> {{upload_count}}</p>
</div>

<p>The files will be kept for {{grace_days}} more days (until {{delete_date}})
so you can re-share or retrieve anything you still need, then they are
automatically deleted.</p>

<p><a href="{{admin_url}}">Open PicTransfer in the admin area</a></p>

<p>Best regards,<br>
Your PicPeak Installation</p>`,
      body_text_en: `A transfer link has expired

The following file transfer is no longer downloadable by its recipient:

Transfer: {{transfer_title}}
Expired at: {{expiry_date}}
Files included: {{file_count}}
Client uploads received: {{upload_count}}

The files will be kept for {{grace_days}} more days (until {{delete_date}}) so
you can re-share or retrieve anything you still need, then they are
automatically deleted.

Open PicTransfer in the admin area: {{admin_url}}

Best regards,
Your PicPeak Installation`,
      body_html_de: `
<h2>Ein Transfer-Link ist abgelaufen</h2>

<p>Der folgende Datei-Transfer kann vom Empfänger nicht mehr heruntergeladen werden:</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Transfer:</strong> {{transfer_title}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Abgelaufen am:</strong> {{expiry_date}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Enthaltene Dateien:</strong> {{file_count}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Empfangene Kunden-Uploads:</strong> {{upload_count}}</p>
</div>

<p>Die Dateien werden noch {{grace_days}} Tage aufbewahrt (bis {{delete_date}}),
damit Sie alles Benötigte erneut teilen oder abrufen können; danach werden sie
automatisch gelöscht.</p>

<p><a href="{{admin_url}}">PicTransfer im Admin-Bereich öffnen</a></p>

<p>Mit freundlichen Grüßen,<br>
Ihre PicPeak-Installation</p>`,
      body_text_de: `Ein Transfer-Link ist abgelaufen

Der folgende Datei-Transfer kann vom Empfänger nicht mehr heruntergeladen werden:

Transfer: {{transfer_title}}
Abgelaufen am: {{expiry_date}}
Enthaltene Dateien: {{file_count}}
Empfangene Kunden-Uploads: {{upload_count}}

Die Dateien werden noch {{grace_days}} Tage aufbewahrt (bis {{delete_date}}),
danach werden sie automatisch gelöscht.

PicTransfer im Admin-Bereich öffnen: {{admin_url}}

Mit freundlichen Grüßen,
Ihre PicPeak-Installation`,
      variables: JSON.stringify([
        'transfer_title', 'expiry_date', 'file_count', 'upload_count',
        'grace_days', 'delete_date', 'admin_url',
      ]),
    });
  }
};

exports.down = async function (knex) {
  await knex('email_templates').where('template_key', 'transfer_link_expired').del();
  await knex('app_settings')
    .whereIn('setting_key', [
      'transfer_default_expiry_days',
      'transfer_default_grace_days',
      'transfer_default_max_downloads',
      'transfer_max_upload_size_mb',
      'transfer_upload_allowed_mime',
    ])
    .del();
  await knex.schema.dropTableIfExists('transfer_downloads');
  await knex.schema.dropTableIfExists('transfer_uploads');
  await knex.schema.dropTableIfExists('transfer_files');
  await knex.schema.dropTableIfExists('transfers');
};

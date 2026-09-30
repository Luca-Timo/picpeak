/**
 * Migration 257: PicTransfer — split "send files" from "request files" (#1544).
 *
 * 170/171 modelled receiving as a bolt-on to sending: one `transfers` row was a
 * send (gallery photos + admin extras behind a 64-hex token) that could
 * optionally flip on `allow_uploads` and hand out a short upload code. That made
 * "just collect files from a client" an awkward send with no files, a dead
 * download link and a download-page message nobody reads.
 *
 * This makes the two first-class and mutually exclusive:
 *
 *   kind = 'send'     Files go OUT. `token` is the recipient download link.
 *                     Never accepts uploads.
 *   kind = 'request'  Files come IN. `token` is the (64-hex) upload link and
 *                     `expires_at` is the single upload deadline; the short
 *                     `upload_token` survives as an optional read-aloud code.
 *                     Never serves a download.
 *
 * Existing rows that did BOTH (photos/extras *and* allow_uploads) are split into
 * two rows rather than having one half dropped: the original keeps the photos
 * and its download token, a new request row takes the upload token, the upload
 * deadline and the `transfer_uploads` already received. Both links a client may
 * already be holding keep working.
 *
 * Also lands the settings + templates the split needs:
 *   - `transfer_upload_allowed_types` ({mime, extensions[]} list) and
 *     `transfer_upload_accept_all`, migrated from `transfer_upload_allowed_mime`.
 *     The old key is left in place; the service reads it as a fallback.
 *   - `transfer_request` (to the client: "please upload") and
 *     `transfer_files_received` (to the admin: "N files arrived").
 *
 * Note on the split rows' bytes: a moved `transfer_uploads.stored_path` still
 * points under the OLD transfer's `uploads/transfers/<oldId>/` directory. The
 * per-file deletes work off `stored_path` and are unaffected, and
 * transferService.removeUploadedFiles no longer recursively removes that
 * directory (it only drops it when empty), so deleting the send can't take the
 * request's received files with it.
 */

const crypto = require('crypto');

const { formatBoolean } = require('../../src/utils/dbCompat');

const DEFAULT_ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/tiff', 'application/pdf', 'application/zip',
];

// Extensions for the types 170 seeded, plus the ones admins most often add by
// hand. `image/tiff` and `application/zip` were seeded as allowed but had no
// entry in fileSecurityUtils' registry, so validateFileType rejected them —
// carrying explicit extensions here is what finally makes them work.
const MIME_EXTENSIONS = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/tiff': ['.tif', '.tiff'],
  'image/svg+xml': ['.svg'],
  'image/heic': ['.heic'],
  'image/heif': ['.heif'],
  'image/x-adobe-dng': ['.dng'],
  'application/pdf': ['.pdf'],
  'application/zip': ['.zip'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
  'video/x-msvideo': ['.avi'],
};

/** Best-effort extension list for a MIME an admin added by hand. */
function extensionsFor(mime) {
  if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
  // `application/vnd.…-officedocument.wordprocessingml.document` → no guess.
  // Leave it empty: the validator treats an empty list as "extension not
  // checked for this type", which is the only honest reading of a hand-added
  // MIME we have no registry entry for.
  return [];
}

function parseSettingValue(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

exports.up = async function (knex) {
  // ---------------------------------------------------------------- kind
  if (!(await knex.schema.hasColumn('transfers', 'kind'))) {
    await knex.schema.alterTable('transfers', (table) => {
      // 'send' | 'request'. Defaulting to 'send' makes every pre-existing row
      // a send until the backfill below reclassifies the upload-only ones.
      table.string('kind', 10).notNullable().defaultTo('send');
    });
    await knex.schema.alterTable('transfers', (table) => {
      table.index(['kind'], 'transfers_kind_idx');
    });
  }

  // ------------------------------------------------------------- backfill
  const rows = await knex('transfers').whereNull('deleted_at').select('*');

  for (const row of rows) {
    const allowsUploads = row.allow_uploads === true || row.allow_uploads === 1;
    if (!allowsUploads) continue; // plain send — the column default is already right

    const photoCount = Number(
      (await knex('transfer_files').where('transfer_id', row.id).count('* as c').first())?.c,
    ) || 0;
    const extraCount = Number(
      (await knex('transfer_extra_files').where('transfer_id', row.id).count('* as c').first())?.c,
    ) || 0;
    const hasOutbound = photoCount + extraCount > 0;

    // The upload deadline becomes the request's single `expires_at`.
    const uploadDeadline = row.upload_expires_at || row.expires_at;

    if (!hasOutbound) {
      // Upload-only already: convert in place. It keeps its 64-hex `token`,
      // which is exactly the high-entropy request link the new flow wants.
      await knex('transfers').where({ id: row.id }).update({
        kind: 'request',
        expires_at: uploadDeadline,
        upload_expires_at: null,
        max_downloads: null,
        updated_at: new Date(),
      });
      continue;
    }

    // Did both: keep the send, spin the receiving half out into its own row.
    //
    // The send releases the short code FIRST. `upload_token` carries a UNIQUE
    // constraint, so inserting the request row while the send still holds the
    // same value would fail the whole migration.
    const shortCode = row.upload_token || null;
    await knex('transfers').where({ id: row.id }).update({
      kind: 'send',
      allow_uploads: formatBoolean(false),
      upload_token: null,
      upload_expires_at: null,
      updated_at: new Date(),
    });

    const newToken = await uniqueDownloadToken(knex);
    const inserted = await knex('transfers').insert({
      token: newToken,
      title: row.title || '',
      message: row.message || null,
      created_by: row.created_by || null,
      kind: 'request',
      expires_at: uploadDeadline,
      max_downloads: null,
      download_count: 0,
      is_active: row.is_active,
      disabled_at: row.disabled_at || null,
      grace_days: row.grace_days,
      allow_uploads: formatBoolean(true),
      upload_token: shortCode,
      upload_expires_at: null,
      delivery_method: row.delivery_method || 'link',
      created_at: row.created_at || new Date(),
      updated_at: new Date(),
    }).returning('id');
    const newId = typeof inserted[0] === 'object' && inserted[0] !== null
      ? inserted[0].id
      : inserted[0];

    // Received files follow the request. Their stored_path still points under
    // the old transfer's directory — see the header note.
    await knex('transfer_uploads').where('transfer_id', row.id).update({ transfer_id: newId });
  }

  // ------------------------------------------------------------- settings
  const legacyRow = await knex('app_settings')
    .where('setting_key', 'transfer_upload_allowed_mime')
    .first();
  const legacyList = parseSettingValue(legacyRow && legacyRow.setting_value, DEFAULT_ALLOWED_MIME);
  const mimes = Array.isArray(legacyList) && legacyList.length ? legacyList : DEFAULT_ALLOWED_MIME;

  const allowedTypes = [...new Set(mimes.map((m) => String(m || '').trim().toLowerCase()).filter(Boolean))]
    .map((mime) => ({ mime, extensions: extensionsFor(mime) }));

  const newSettings = [
    {
      setting_key: 'transfer_upload_allowed_types',
      setting_value: JSON.stringify(allowedTypes),
      setting_type: 'general',
    },
    {
      setting_key: 'transfer_upload_accept_all',
      setting_value: JSON.stringify(false),
      setting_type: 'boolean',
    },
  ];
  for (const s of newSettings) {
    const exists = await knex('app_settings').where('setting_key', s.setting_key).first();
    if (!exists) {
      await knex('app_settings').insert({ ...s, updated_at: knex.fn.now() });
    }
  }

  // ------------------------------------------------------------ templates
  await insertTemplate(knex, {
    template_key: 'transfer_request',
    subject_en: 'Please upload your files — {{transfer_title}}',
    subject_de: 'Bitte laden Sie Ihre Dateien hoch — {{transfer_title}}',
    body_html_en: `
<h2>Please upload your files</h2>

<p>{{transfer_title}}</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;">{{message}}</p>
</div>

<p style="margin: 24px 0;">
  <a href="{{upload_url}}" class="button">Upload your files</a>
</p>

<p><strong>Please upload by:</strong> {{expiry_date}}</p>

<p style="color: #888; font-size: 13px;">If the button doesn't work, copy this link into your browser:<br>{{upload_url}}</p>

<p>Best regards,<br>
Your PicPeak Installation</p>`,
    body_text_en: `Please upload your files

{{transfer_title}}

{{message}}

Upload your files: {{upload_url}}

Please upload by: {{expiry_date}}

Best regards,
Your PicPeak Installation`,
    body_html_de: `
<h2>Bitte laden Sie Ihre Dateien hoch</h2>

<p>{{transfer_title}}</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;">{{message}}</p>
</div>

<p style="margin: 24px 0;">
  <a href="{{upload_url}}" class="button">Dateien hochladen</a>
</p>

<p><strong>Bitte hochladen bis:</strong> {{expiry_date}}</p>

<p style="color: #888; font-size: 13px;">Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:<br>{{upload_url}}</p>

<p>Mit freundlichen Grüßen,<br>
Ihre PicPeak-Installation</p>`,
    body_text_de: `Bitte laden Sie Ihre Dateien hoch

{{transfer_title}}

{{message}}

Dateien hochladen: {{upload_url}}

Bitte hochladen bis: {{expiry_date}}

Mit freundlichen Grüßen,
Ihre PicPeak-Installation`,
    variables: JSON.stringify(['transfer_title', 'message', 'upload_url', 'upload_code', 'expiry_date']),
  });

  await insertTemplate(knex, {
    template_key: 'transfer_files_received',
    subject_en: 'Files received — {{transfer_title}}',
    subject_de: 'Dateien erhalten — {{transfer_title}}',
    body_html_en: `
<h2>Files received</h2>

<p>{{file_count}} file(s) were uploaded to <strong>{{transfer_title}}</strong>.</p>

<p><strong>Received:</strong> {{received_at}}<br>
<strong>Files in this request so far:</strong> {{total_count}}</p>

<p style="margin: 24px 0;">
  <a href="{{admin_url}}" class="button">Open in PicPeak</a>
</p>

<p style="color: #888; font-size: 13px;">Uploaded files are stored as-is and are never opened or processed by PicPeak. Scan them before you use them.</p>

<p>Best regards,<br>
Your PicPeak Installation</p>`,
    body_text_en: `Files received

{{file_count}} file(s) were uploaded to {{transfer_title}}.

Received: {{received_at}}
Files in this request so far: {{total_count}}

Open in PicPeak: {{admin_url}}

Uploaded files are stored as-is and are never opened or processed by PicPeak. Scan them before you use them.

Best regards,
Your PicPeak Installation`,
    body_html_de: `
<h2>Dateien erhalten</h2>

<p>{{file_count}} Datei(en) wurden zu <strong>{{transfer_title}}</strong> hochgeladen.</p>

<p><strong>Erhalten:</strong> {{received_at}}<br>
<strong>Dateien in dieser Anfrage bisher:</strong> {{total_count}}</p>

<p style="margin: 24px 0;">
  <a href="{{admin_url}}" class="button">In PicPeak öffnen</a>
</p>

<p style="color: #888; font-size: 13px;">Hochgeladene Dateien werden unverändert gespeichert und von PicPeak nie geöffnet oder verarbeitet. Prüfen Sie sie, bevor Sie sie verwenden.</p>

<p>Mit freundlichen Grüßen,<br>
Ihre PicPeak-Installation</p>`,
    body_text_de: `Dateien erhalten

{{file_count}} Datei(en) wurden zu {{transfer_title}} hochgeladen.

Erhalten: {{received_at}}
Dateien in dieser Anfrage bisher: {{total_count}}

In PicPeak öffnen: {{admin_url}}

Hochgeladene Dateien werden unverändert gespeichert und von PicPeak nie geöffnet oder verarbeitet. Prüfen Sie sie, bevor Sie sie verwenden.

Mit freundlichen Grüßen,
Ihre PicPeak-Installation`,
    variables: JSON.stringify(['transfer_title', 'file_count', 'total_count', 'received_at', 'admin_url']),
  });
};

async function uniqueDownloadToken(knex) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = crypto.randomBytes(32).toString('hex');
    const clash = await knex('transfers').where({ token: candidate }).first('id');
    if (!clash) return candidate;
  }
  // 256 bits: reaching here means something other than chance is wrong, but a
  // migration must not loop forever.
  return crypto.randomBytes(32).toString('hex');
}

async function insertTemplate(knex, template) {
  const existing = await knex('email_templates').where('template_key', template.template_key).first();
  if (existing) return;
  await knex('email_templates').insert(template);
}

exports.down = async function (knex) {
  await knex('email_templates')
    .whereIn('template_key', ['transfer_request', 'transfer_files_received'])
    .del();
  await knex('app_settings')
    .whereIn('setting_key', ['transfer_upload_allowed_types', 'transfer_upload_accept_all'])
    .del();
  // The row split is not reversed: merging a request back into the send it came
  // from would have to guess which send, and the request rows are legitimate
  // records of files a client actually sent. Dropping `kind` just makes every
  // row a transfer again, which is what the pre-257 code expects.
  if (await knex.schema.hasColumn('transfers', 'kind')) {
    await knex.schema.alterTable('transfers', (table) => {
      table.dropIndex(['kind'], 'transfers_kind_idx');
    });
    await knex.schema.alterTable('transfers', (table) => {
      table.dropColumn('kind');
    });
  }
};

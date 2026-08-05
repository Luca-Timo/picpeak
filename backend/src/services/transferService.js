/**
 * transferService — PicTransfer (#997).
 *
 * A "transfer" is a share link that bundles ORIGINAL photos picked from any
 * number of events and hands them to a recipient (à la WeTransfer). It can
 * also open a short (6-char) upload token so the client can send files back
 * (logos etc.).
 *
 * Design decisions (from the issue):
 *   - Downloads always serve ORIGINAL files, never watermarked — a transfer is
 *     a deliberate hand-off, not a preview.
 *   - The ZIP is built on demand by replicating the gallery download-selected
 *     loop (resolvePhotoStorageKey → storage.get → archiver), generalised to
 *     span multiple events. No pre-generation / caching.
 *   - The link is simply disabled after `expires_at`; an optional max-downloads
 *     cap can disable it earlier. Files are kept `grace_days` days past disable
 *     (retention), then the cleanup sweep hard-deletes them.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');
const { getAppSetting } = require('../utils/appSettings');
const { getStorage } = require('./storage');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { getUseOriginalFilenames, getZipEntryNames } = require('./downloadFilenameService');
const { sanitizeForZipEntry } = require('../utils/filenameSanitizer');

// Unambiguous alphabet for the client upload token — no 0/O/1/I/L to keep it
// easy to read aloud / type from an email. 6 chars ≈ 31 bits; brute force is
// mitigated by the per-route rate limiter + IP lockout on the upload endpoint.
const UPLOAD_TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const UPLOAD_TOKEN_LENGTH = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function generateDownloadToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars
}

function generateUploadTokenCandidate() {
  const bytes = crypto.randomBytes(UPLOAD_TOKEN_LENGTH);
  let out = '';
  for (let i = 0; i < UPLOAD_TOKEN_LENGTH; i += 1) {
    out += UPLOAD_TOKEN_ALPHABET[bytes[i] % UPLOAD_TOKEN_ALPHABET.length];
  }
  return out;
}

async function generateUniqueUploadToken(conn = db) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = generateUploadTokenCandidate();
    const clash = await conn('transfers').where({ upload_token: candidate }).first('id');
    if (!clash) return candidate;
  }
  // Astronomically unlikely; fall back to a longer token so we never loop.
  return generateUploadTokenCandidate() + generateUploadTokenCandidate();
}

/** Storage-relative directory that holds a transfer's client uploads. */
function uploadDirKey(transferId) {
  return path.posix.join('uploads/transfers', String(transferId));
}

/**
 * Derive the recipient-facing/admin status of a transfer row.
 * Never mutates — the cron sweep is what actually flips is_active/deleted_at.
 */
function computeStatus(transfer) {
  if (transfer.deleted_at) return 'deleted';
  const now = Date.now();
  const expired = !transfer.is_active
    || (transfer.expires_at && new Date(transfer.expires_at).getTime() <= now);
  if (expired) return 'expired';
  return 'active';
}

function downloadsRemaining(transfer) {
  const cap = Number(transfer.max_downloads) || 0;
  if (cap <= 0) return null; // unlimited
  return Math.max(0, cap - (Number(transfer.download_count) || 0));
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

async function createTransfer(input, adminId) {
  const {
    title = '',
    message = null,
    expiresInDays,
    maxDownloads,
    graceDays,
    allowUploads = false,
    uploadExpiresInDays,
    photoIds = [],
  } = input || {};

  const defaultExpiry = await getAppSetting('transfer_default_expiry_days', 14);
  const defaultGrace = await getAppSetting('transfer_default_grace_days', 7);
  const defaultMax = await getAppSetting('transfer_default_max_downloads', 0);

  const expiryDays = Number.isFinite(Number(expiresInDays)) && Number(expiresInDays) > 0
    ? Number(expiresInDays) : Number(defaultExpiry) || 14;
  const grace = Number.isFinite(Number(graceDays)) && Number(graceDays) >= 0
    ? Number(graceDays) : Number(defaultGrace) || 7;
  const cap = Number.isFinite(Number(maxDownloads)) && Number(maxDownloads) > 0
    ? Number(maxDownloads) : (Number(defaultMax) > 0 ? Number(defaultMax) : null);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiryDays * DAY_MS);

  const row = {
    token: generateDownloadToken(),
    title: String(title || '').slice(0, 255),
    message: message || null,
    created_by: adminId || null,
    expires_at: expiresAt,
    max_downloads: cap,
    download_count: 0,
    is_active: formatBoolean(true),
    grace_days: grace,
    allow_uploads: formatBoolean(!!allowUploads),
    created_at: now,
    updated_at: now,
  };

  if (allowUploads) {
    row.upload_token = await generateUniqueUploadToken();
    const uploadDays = Number.isFinite(Number(uploadExpiresInDays)) && Number(uploadExpiresInDays) > 0
      ? Number(uploadExpiresInDays) : expiryDays;
    row.upload_expires_at = new Date(now.getTime() + uploadDays * DAY_MS);
  }

  const [id] = await db('transfers').insert(row).returning('id');
  const transferId = typeof id === 'object' && id !== null ? id.id : id;

  if (Array.isArray(photoIds) && photoIds.length) {
    await addFiles(transferId, photoIds);
  }

  return getTransfer(transferId);
}

async function listTransfers({ search = '' } = {}) {
  let query = db('transfers')
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc');

  if (search) {
    query = query.where('title', 'like', `%${search}%`);
  }

  const rows = await query;
  const ids = rows.map((r) => r.id);

  // File + upload counts in two grouped queries rather than N+1.
  const fileCounts = ids.length
    ? await db('transfer_files').whereIn('transfer_id', ids)
      .select('transfer_id').count('* as count').groupBy('transfer_id')
    : [];
  const uploadCounts = ids.length
    ? await db('transfer_uploads').whereIn('transfer_id', ids)
      .select('transfer_id').count('* as count').groupBy('transfer_id')
    : [];
  const fileCountMap = new Map(fileCounts.map((r) => [r.transfer_id, Number(r.count)]));
  const uploadCountMap = new Map(uploadCounts.map((r) => [r.transfer_id, Number(r.count)]));

  return rows.map((r) => ({
    ...serializeTransfer(r),
    file_count: fileCountMap.get(r.id) || 0,
    upload_count: uploadCountMap.get(r.id) || 0,
  }));
}

function serializeTransfer(row) {
  return {
    id: row.id,
    token: row.token,
    title: row.title,
    message: row.message,
    created_by: row.created_by,
    expires_at: row.expires_at,
    max_downloads: row.max_downloads || null,
    download_count: row.download_count || 0,
    downloads_remaining: downloadsRemaining(row),
    is_active: row.is_active === true || row.is_active === 1,
    disabled_at: row.disabled_at || null,
    grace_days: row.grace_days,
    deleted_at: row.deleted_at || null,
    allow_uploads: row.allow_uploads === true || row.allow_uploads === 1,
    upload_token: row.upload_token || null,
    upload_expires_at: row.upload_expires_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: computeStatus(row),
    download_url: `/transfer/${row.token}`,
    upload_url: row.upload_token ? `/transfer-upload/${row.upload_token}` : null,
  };
}

/** Full detail: transfer + its files (with photo/event info) + client uploads. */
async function getTransfer(id) {
  const row = await db('transfers').where({ id }).first();
  if (!row) return null;

  const files = await db('transfer_files')
    .join('photos', 'photos.id', 'transfer_files.photo_id')
    .join('events', 'events.id', 'photos.event_id')
    .where('transfer_files.transfer_id', id)
    .orderBy('transfer_files.sort_order', 'asc')
    .orderBy('transfer_files.id', 'asc')
    .select(
      'transfer_files.id as file_id',
      'transfer_files.sort_order',
      'photos.id as photo_id',
      'photos.filename',
      'photos.original_filename',
      'photos.type',
      'photos.size_bytes',
      'photos.event_id',
      'events.event_name',
      'events.slug as event_slug',
    );

  const uploads = await db('transfer_uploads')
    .where('transfer_id', id)
    .orderBy('uploaded_at', 'desc')
    .select('id', 'original_filename', 'size_bytes', 'mime_type', 'uploader_ip', 'uploaded_at');

  return {
    ...serializeTransfer(row),
    file_count: files.length,
    upload_count: uploads.length,
    files: files.map((f) => ({
      file_id: f.file_id,
      photo_id: f.photo_id,
      filename: f.original_filename || f.filename,
      type: f.type,
      size_bytes: f.size_bytes,
      event_id: f.event_id,
      event_name: f.event_name,
      event_slug: f.event_slug,
      // Admin picker previews thumbnails via the existing admin photo endpoint.
      thumbnail_url: `/admin/photos/${f.event_id}/thumbnail/${f.photo_id}`,
    })),
    uploads,
  };
}

async function updateTransfer(id, fields) {
  const row = await db('transfers').where({ id }).first();
  if (!row) return null;

  const update = { updated_at: new Date() };
  if (fields.title !== undefined) update.title = String(fields.title || '').slice(0, 255);
  if (fields.message !== undefined) update.message = fields.message || null;
  if (fields.maxDownloads !== undefined) {
    const cap = Number(fields.maxDownloads);
    update.max_downloads = Number.isFinite(cap) && cap > 0 ? cap : null;
  }
  if (fields.graceDays !== undefined) {
    const grace = Number(fields.graceDays);
    if (Number.isFinite(grace) && grace >= 0) update.grace_days = grace;
  }
  if (fields.expiresAt !== undefined) {
    update.expires_at = new Date(fields.expiresAt);
  } else if (fields.expiresInDays !== undefined) {
    const days = Number(fields.expiresInDays);
    if (Number.isFinite(days) && days > 0) {
      update.expires_at = new Date(Date.now() + days * DAY_MS);
    }
  }
  if (fields.isActive !== undefined) {
    update.is_active = formatBoolean(!!fields.isActive);
    // Re-activating clears the retention clock; disabling starts it.
    if (fields.isActive) {
      update.disabled_at = null;
      update.admin_notified_at = null;
    } else if (!row.disabled_at) {
      update.disabled_at = new Date();
    }
  }

  await db('transfers').where({ id }).update(update);
  return getTransfer(id);
}

async function deleteTransfer(id) {
  const row = await db('transfers').where({ id }).first();
  if (!row) return false;
  await removeUploadedFiles(id);
  // transfer_files / transfer_uploads / transfer_downloads cascade on the FK,
  // but we delete explicitly too so the feature works even where SQLite FK
  // enforcement is off.
  await db('transfer_files').where({ transfer_id: id }).del();
  await db('transfer_uploads').where({ transfer_id: id }).del();
  await db('transfer_downloads').where({ transfer_id: id }).del();
  await db('transfers').where({ id }).del();
  return true;
}

async function addFiles(transferId, photoIds) {
  const ids = [...new Set((photoIds || []).map((n) => parseInt(n, 10)).filter(Boolean))];
  if (!ids.length) return getTransfer(transferId);

  // Only real, existing photos.
  const existing = await db('photos').whereIn('id', ids).select('id');
  const validIds = new Set(existing.map((p) => p.id));

  // Skip photos already attached (the unique index would reject them anyway).
  const already = await db('transfer_files')
    .where('transfer_id', transferId)
    .whereIn('photo_id', ids)
    .select('photo_id');
  const alreadySet = new Set(already.map((r) => r.photo_id));

  const maxOrderRow = await db('transfer_files')
    .where('transfer_id', transferId)
    .max('sort_order as max')
    .first();
  let order = (maxOrderRow && Number(maxOrderRow.max)) || 0;

  const rows = ids
    .filter((pid) => validIds.has(pid) && !alreadySet.has(pid))
    .map((pid) => {
      order += 1;
      return { transfer_id: transferId, photo_id: pid, sort_order: order, created_at: new Date() };
    });

  if (rows.length) {
    await db('transfer_files').insert(rows);
    await db('transfers').where({ id: transferId }).update({ updated_at: new Date() });
  }
  return getTransfer(transferId);
}

async function removeFile(transferId, fileId) {
  await db('transfer_files').where({ id: fileId, transfer_id: transferId }).del();
  await db('transfers').where({ id: transferId }).update({ updated_at: new Date() });
  return getTransfer(transferId);
}

async function enableUploads(transferId, { uploadExpiresInDays } = {}) {
  const row = await db('transfers').where({ id: transferId }).first();
  if (!row) return null;
  const now = new Date();
  const days = Number.isFinite(Number(uploadExpiresInDays)) && Number(uploadExpiresInDays) > 0
    ? Number(uploadExpiresInDays)
    : Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - now.getTime()) / DAY_MS));
  const update = {
    allow_uploads: formatBoolean(true),
    upload_token: row.upload_token || (await generateUniqueUploadToken()),
    upload_expires_at: new Date(now.getTime() + days * DAY_MS),
    updated_at: now,
  };
  await db('transfers').where({ id: transferId }).update(update);
  return getTransfer(transferId);
}

async function disableUploads(transferId) {
  await db('transfers').where({ id: transferId }).update({
    allow_uploads: formatBoolean(false),
    upload_token: null,
    upload_expires_at: null,
    updated_at: new Date(),
  });
  return getTransfer(transferId);
}

// ---------------------------------------------------------------------------
// Public lookups (token-authenticated)
// ---------------------------------------------------------------------------

async function getTransferByToken(token) {
  return db('transfers').where({ token }).whereNull('deleted_at').first();
}

async function getTransferByUploadToken(uploadToken) {
  return db('transfers').where({ upload_token: uploadToken }).whereNull('deleted_at').first();
}

/**
 * Recipient-facing projection — filenames + sizes only. The download page has
 * NO thumbnails by design, so we deliberately don't expose any image URLs.
 */
async function getPublicView(transfer) {
  const files = await db('transfer_files')
    .join('photos', 'photos.id', 'transfer_files.photo_id')
    .where('transfer_files.transfer_id', transfer.id)
    .orderBy('transfer_files.sort_order', 'asc')
    .orderBy('transfer_files.id', 'asc')
    .select(
      'transfer_files.id as file_id',
      'photos.filename',
      'photos.original_filename',
      'photos.size_bytes',
    );

  const useOriginal = await getUseOriginalFilenames();
  const totalBytes = files.reduce((sum, f) => sum + (Number(f.size_bytes) || 0), 0);

  return {
    title: transfer.title || 'Transfer',
    message: transfer.message || null,
    expires_at: transfer.expires_at,
    file_count: files.length,
    total_bytes: totalBytes,
    downloads_remaining: downloadsRemaining(transfer),
    files: files.map((f) => ({
      file_id: f.file_id,
      filename: (useOriginal && f.original_filename) ? f.original_filename : f.filename,
      size_bytes: f.size_bytes || null,
    })),
  };
}

/**
 * Whether a transfer can currently be downloaded. Returns a reason code so the
 * route can map it to a clean 403/410.
 */
function assertDownloadable(transfer) {
  if (!transfer || transfer.deleted_at) return { ok: false, code: 'NOT_FOUND', status: 404 };
  const isActive = transfer.is_active === true || transfer.is_active === 1;
  if (!isActive) return { ok: false, code: 'TRANSFER_DISABLED', status: 410 };
  if (transfer.expires_at && new Date(transfer.expires_at).getTime() <= Date.now()) {
    return { ok: false, code: 'TRANSFER_EXPIRED', status: 410 };
  }
  const remaining = downloadsRemaining(transfer);
  if (remaining !== null && remaining <= 0) {
    return { ok: false, code: 'DOWNLOAD_LIMIT_REACHED', status: 410 };
  }
  return { ok: true };
}

/** Record one download and, if it hit the cap, flip the link inactive. */
async function recordDownload(transfer, { kind = 'all', photoId = null, ip = null } = {}) {
  await db('transfer_downloads').insert({
    transfer_id: transfer.id,
    kind,
    photo_id: photoId,
    ip,
    downloaded_at: new Date(),
  });
  const updated = await db('transfers').where({ id: transfer.id })
    .increment('download_count', 1);
  void updated;

  const cap = Number(transfer.max_downloads) || 0;
  if (cap > 0 && (Number(transfer.download_count) || 0) + 1 >= cap) {
    // Cap reached — disable and start the retention clock.
    await db('transfers').where({ id: transfer.id }).update({
      is_active: formatBoolean(false),
      disabled_at: new Date(),
      updated_at: new Date(),
    });
  }
}

// ---------------------------------------------------------------------------
// ZIP building — cross-event, originals only
// ---------------------------------------------------------------------------

/** Load the ordered photos for a transfer, each joined to its event. */
async function loadTransferPhotos(transferId) {
  const rows = await db('transfer_files')
    .join('photos', 'photos.id', 'transfer_files.photo_id')
    .join('events', 'events.id', 'photos.event_id')
    .where('transfer_files.transfer_id', transferId)
    .orderBy('transfer_files.sort_order', 'asc')
    .orderBy('transfer_files.id', 'asc')
    .select(
      'photos.*',
      'events.slug as event_slug',
      'events.event_name as event_name',
      'events.source_mode as event_source_mode',
      'events.external_path as event_external_path',
    );
  return rows;
}

/**
 * Stream a ZIP of a transfer's ORIGINAL files to `res`. Mirrors the gallery
 * download-selected loop but spans events: each photo carries its own event
 * fields (aliased above) so the resolver gets the right event. Photos are
 * grouped into per-event subfolders to keep same-named files apart.
 *
 * Returns the number of files successfully appended.
 */
async function streamTransferArchive(transfer, res) {
  const photos = await loadTransferPhotos(transfer.id);

  const archiveName = `${sanitizeForZipEntry(transfer.title || 'transfer') || 'transfer'}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    logger.error('transferService: archive error', { transferId: transfer.id, error: err.message });
    try { res.destroy(err); } catch (_) { /* noop */ }
  });
  archive.pipe(res);

  const storage = getStorage();
  const useOriginal = await getUseOriginalFilenames();
  const entryNames = getZipEntryNames(photos, useOriginal);
  const multiEvent = new Set(photos.map((p) => p.event_id)).size > 1;

  let appended = 0;
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const event = {
      id: photo.event_id,
      slug: photo.event_slug,
      source_mode: photo.event_source_mode,
      external_path: photo.event_external_path,
    };
    let name = entryNames[i] || `photo-${photo.id}.jpg`;
    // Only foldered when the transfer actually spans multiple events, so a
    // single-event transfer stays flat.
    if (multiEvent) {
      const folder = sanitizeForZipEntry(photo.event_name || photo.event_slug || `event-${photo.event_id}`);
      name = `${folder}/${name}`;
    }
    try {
      const storageKey = resolvePhotoStorageKey(event, photo);
      if (storageKey && storage.kind() === 'local') {
        const srcStat = await storage.stat(storageKey);
        if (!srcStat) throw new Error(`Photo missing in storage: ${storageKey}`);
      } else if (!storageKey && !fs.existsSync(resolvePhotoFilePath(event, photo))) {
        throw new Error('Photo file missing on disk');
      }

      if (storageKey) {
        const stream = await storage.get(storageKey);
        archive.append(stream, { name });
      } else {
        archive.file(resolvePhotoFilePath(event, photo), { name });
      }
      appended += 1;
    } catch (err) {
      logger.warn('transferService: skipping photo in transfer archive', {
        transferId: transfer.id, photoId: photo.id, error: err.message,
      });
    }
  }

  await archive.finalize();
  return appended;
}

/**
 * Stream a single ORIGINAL file from a transfer to `res`. Returns false when
 * the file id isn't part of this transfer or the bytes are missing.
 */
async function streamTransferFile(transfer, fileId, res) {
  const row = await db('transfer_files')
    .join('photos', 'photos.id', 'transfer_files.photo_id')
    .join('events', 'events.id', 'photos.event_id')
    .where('transfer_files.transfer_id', transfer.id)
    .where('transfer_files.id', fileId)
    .select(
      'photos.*',
      'events.slug as event_slug',
      'events.source_mode as event_source_mode',
      'events.external_path as event_external_path',
    )
    .first();
  if (!row) return false;

  const event = {
    id: row.event_id,
    slug: row.event_slug,
    source_mode: row.event_source_mode,
    external_path: row.event_external_path,
  };
  const useOriginal = await getUseOriginalFilenames();
  const [name] = getZipEntryNames([row], useOriginal);
  const filename = name || row.filename || `photo-${row.id}.jpg`;

  // Resolve + verify the source exists BEFORE writing any response header, so a
  // missing file yields a clean 404 rather than a truncated 200. The joined row
  // carries photos.* (path / source_origin / external_relpath), so it is a
  // valid photo object for the resolver as-is.
  const storage = getStorage();
  const storageKey = resolvePhotoStorageKey(event, row);
  let source; // { type: 'stream' | 'file', value }
  if (storageKey) {
    if (storage.kind() === 'local') {
      const srcStat = await storage.stat(storageKey);
      if (!srcStat) return false;
    }
    source = { type: 'stream', value: await storage.get(storageKey) };
  } else {
    const abs = resolvePhotoFilePath(event, row);
    if (!fs.existsSync(abs)) return false;
    source = { type: 'file', value: abs };
  }

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  if (source.type === 'stream') {
    source.value.pipe(res);
  } else {
    fs.createReadStream(source.value).pipe(res);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Client uploads
// ---------------------------------------------------------------------------

function assertUploadable(transfer) {
  if (!transfer || transfer.deleted_at) return { ok: false, code: 'NOT_FOUND', status: 404 };
  const allow = transfer.allow_uploads === true || transfer.allow_uploads === 1;
  if (!allow) return { ok: false, code: 'UPLOADS_DISABLED', status: 403 };
  const exp = transfer.upload_expires_at || transfer.expires_at;
  if (exp && new Date(exp).getTime() <= Date.now()) {
    return { ok: false, code: 'UPLOAD_EXPIRED', status: 410 };
  }
  return { ok: true };
}

/** Record a client-uploaded file (bytes already written by the route/multer). */
async function addUpload(transferId, { originalFilename, storedPath, sizeBytes, mimeType, ip }) {
  const [id] = await db('transfer_uploads').insert({
    transfer_id: transferId,
    original_filename: String(originalFilename || 'file').slice(0, 512),
    stored_path: storedPath,
    size_bytes: sizeBytes || null,
    mime_type: mimeType || null,
    uploader_ip: ip || null,
    uploaded_at: new Date(),
  }).returning('id');
  await db('transfers').where({ id: transferId }).update({ updated_at: new Date() });
  return typeof id === 'object' && id !== null ? id.id : id;
}

/** Resolve the on-disk path of a stored upload for admin download / deletion. */
async function getUpload(transferId, uploadId) {
  const upload = await db('transfer_uploads')
    .where({ id: uploadId, transfer_id: transferId })
    .first();
  if (!upload) return null;
  const storage = getStorage();
  let localPath = null;
  try {
    localPath = storage.kind() === 'local' ? storage.resolveLocalPath(upload.stored_path) : null;
  } catch (_) {
    localPath = null;
  }
  return { ...upload, localPath };
}

/** Delete all client-uploaded bytes for a transfer (retention / hard delete). */
async function removeUploadedFiles(transferId) {
  const uploads = await db('transfer_uploads').where({ transfer_id: transferId }).select('stored_path');
  const storage = getStorage();
  for (const u of uploads) {
    if (!u.stored_path) continue;
    try {
      await storage.delete(u.stored_path);
    } catch (err) {
      logger.warn('transferService: failed to delete upload file', {
        transferId, path: u.stored_path, error: err.message,
      });
    }
  }
  // Best-effort: remove the now-empty per-transfer directory on local storage.
  try {
    if (storage.kind() === 'local') {
      const dir = storage.resolveLocalPath(uploadDirKey(transferId));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) { /* noop */ }
}

module.exports = {
  // constants / helpers
  UPLOAD_TOKEN_LENGTH,
  getFrontendUrl,
  uploadDirKey,
  computeStatus,
  downloadsRemaining,
  // admin CRUD
  createTransfer,
  listTransfers,
  getTransfer,
  updateTransfer,
  deleteTransfer,
  addFiles,
  removeFile,
  enableUploads,
  disableUploads,
  // public
  getTransferByToken,
  getTransferByUploadToken,
  getPublicView,
  assertDownloadable,
  recordDownload,
  streamTransferArchive,
  streamTransferFile,
  // uploads
  assertUploadable,
  addUpload,
  getUpload,
  removeUploadedFiles,
};

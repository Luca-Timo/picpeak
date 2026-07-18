/**
 * Maps file extensions to MIME types for upload validation.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  // HEIC/HEIF (iPhone) — kept in sync with the backend EXTENSION_TO_MIME.
  heic: 'image/heic',
  heif: 'image/heif',
  // Camera RAW / Apple ProRAW — backend extracts the embedded JPEG preview.
  dng: 'image/x-adobe-dng',
};

const DEFAULT_ALLOWED = 'jpg,jpeg,png,webp';

/**
 * Convert a comma-separated extension string (e.g. "jpg,png,mp4") to an
 * array of unique MIME types.
 */
export function extensionsToMimeTypes(extString?: string | null): string[] {
  const input = extString?.trim() || DEFAULT_ALLOWED;
  const mimeSet = new Set<string>();

  input.split(',').forEach(ext => {
    const cleaned = ext.trim().toLowerCase().replace(/^\./, '');
    const mime = EXTENSION_TO_MIME[cleaned];
    if (mime) {
      mimeSet.add(mime);
    }
  });

  if (mimeSet.size === 0) {
    return extensionsToMimeTypes(DEFAULT_ALLOWED);
  }

  return Array.from(mimeSet);
}

/**
 * Convert a comma-separated extension string to an HTML `accept` attribute
 * value, e.g. "image/jpeg,image/png,video/mp4".
 */
export function extensionsToAcceptString(extString?: string | null): string {
  return extensionsToMimeTypes(extString).join(',');
}

/**
 * Human-readable, de-duplicated list of the configured extensions for the
 * upload requirements hint, e.g. "JPG, PNG, WEBP, MOV". Only extensions the
 * app actually supports (present in EXTENSION_TO_MIME) are shown, so the hint
 * never advertises a format the backend would reject.
 */
export function extensionsToLabel(extString?: string | null): string {
  const input = extString?.trim() || DEFAULT_ALLOWED;
  const seen = new Set<string>();
  const labels: string[] = [];
  input.split(',').forEach(ext => {
    const cleaned = ext.trim().toLowerCase().replace(/^\./, '');
    if (cleaned && EXTENSION_TO_MIME[cleaned] && !seen.has(cleaned)) {
      seen.add(cleaned);
      labels.push(cleaned.toUpperCase());
    }
  });
  if (labels.length === 0) return extensionsToLabel(DEFAULT_ALLOWED);
  return labels.join(', ');
}

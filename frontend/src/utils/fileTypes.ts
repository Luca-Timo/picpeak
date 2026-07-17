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
};

const DEFAULT_ALLOWED = 'jpg,jpeg,png,webp';

/**
 * Return the configured supported extensions, excluding values the upload
 * pipeline cannot validate. Falls back to the default list when none match.
 */
export function getSupportedExtensions(extString?: string | null): string[] {
  const input = extString?.trim() || DEFAULT_ALLOWED;
  const extensions = input
    .split(',')
    .map(ext => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter(ext => Boolean(EXTENSION_TO_MIME[ext]));

  return extensions.length > 0
    ? Array.from(new Set(extensions))
    : getSupportedExtensions(DEFAULT_ALLOWED);
}

/**
 * Convert a comma-separated extension string (e.g. "jpg,png,mp4") to an
 * array of unique MIME types.
 */
export function extensionsToMimeTypes(extString?: string | null): string[] {
  return Array.from(new Set(
    getSupportedExtensions(extString).map(extension => EXTENSION_TO_MIME[extension])
  ));
}

/**
 * Convert a comma-separated extension string to an HTML `accept` attribute
 * value, e.g. "image/jpeg,image/png,video/mp4".
 */
export function extensionsToAcceptString(extString?: string | null): string {
  return extensionsToMimeTypes(extString).join(',');
}

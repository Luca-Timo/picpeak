const fs = require('fs');
const path = require('path');

const {
  EXTENSION_TO_MIME,
  extensionsToMimeTypes,
} = require('../../src/services/uploadSettings');
const { validateFileType } = require('../../src/utils/fileSecurityUtils');

const RAW_AND_HEIF_TYPES = {
  dng: 'image/x-adobe-dng',
  heic: 'image/heic',
  heif: 'image/heif',
};

function getFrontendExtensionMap() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../../frontend/src/utils/fileTypes.ts'),
    'utf8'
  );
  const match = source.match(/const EXTENSION_TO_MIME[^=]*= \{([\s\S]*?)\n\};/);
  if (!match) throw new Error('Could not find frontend EXTENSION_TO_MIME');

  return Object.fromEntries(
    Array.from(match[1].matchAll(/^(\s*)(\w+): '([^']+)',?$/gm), ([, , extension, mime]) => [extension, mime])
  );
}

describe('configured upload file types', () => {
  test('supports configured DNG, HEIC, and HEIF uploads', () => {
    expect(extensionsToMimeTypes('dng,heic,heif')).toEqual(Object.values(RAW_AND_HEIF_TYPES));

    for (const [extension, mimeType] of Object.entries(RAW_AND_HEIF_TYPES)) {
      expect(validateFileType(`image.${extension}`, mimeType, [mimeType])).toBe(true);
    }
  });

  test('uses the same extension-to-MIME map as the frontend', () => {
    expect(getFrontendExtensionMap()).toEqual(EXTENSION_TO_MIME);
  });
});

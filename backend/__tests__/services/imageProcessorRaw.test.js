/**
 * Unit tests for the RAW/DNG handling helpers (#821). The actual exiftool
 * extraction can only be exercised in the built image (exiftool isn't a dev
 * dependency), so these cover the gating logic: which files are treated as RAW,
 * and that ordinary images pass through untouched (zero cost / no extraction).
 */
const path = require('path');
const { isRawFilename, withProcessableImage, RAW_EXTENSIONS } = require('../../src/services/imageProcessor');

describe('isRawFilename', () => {
  it('recognises common RAW / DNG extensions', () => {
    for (const ext of ['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'rw2', 'orf']) {
      expect(isRawFilename(`IMG_1234.${ext}`)).toBe(true);
      expect(isRawFilename(`IMG_1234.${ext.toUpperCase()}`)).toBe(true); // case-insensitive
    }
  });

  it('does not treat ordinary images/videos as RAW', () => {
    for (const name of ['photo.jpg', 'photo.jpeg', 'photo.png', 'photo.webp', 'clip.mp4', 'clip.mov', 'photo.heic']) {
      expect(isRawFilename(name)).toBe(false);
    }
  });

  it('is null/empty safe', () => {
    expect(isRawFilename(null)).toBe(false);
    expect(isRawFilename('')).toBe(false);
    expect(isRawFilename('noextension')).toBe(false);
  });

  it('RAW_EXTENSIONS includes dng (Apple ProRAW)', () => {
    expect(RAW_EXTENSIONS.has('dng')).toBe(true);
  });
});

describe('withProcessableImage', () => {
  it('passes ordinary images through with no extraction and a no-op cleanup', async () => {
    const localPath = '/tmp/whatever/photo.jpg';
    const proc = await withProcessableImage(localPath, 'photo.jpg');
    expect(proc.path).toBe(localPath);          // unchanged — sharp reads it directly
    expect(proc.outputBasename).toBeUndefined(); // generators keep their default naming
    await expect(Promise.resolve(proc.cleanup())).resolves.toBeUndefined();
  });

  it('routes RAW files to extraction (which fails cleanly without exiftool/preview)', async () => {
    // In the dev sandbox exiftool isn't installed, so extraction throws — the
    // caller turns that into a normal processing failure. In the built image
    // (exiftool present) this instead returns the embedded JPEG preview.
    await expect(withProcessableImage('/tmp/whatever/IMG_1234.dng', 'IMG_1234.dng')).rejects.toThrow();
  });
});

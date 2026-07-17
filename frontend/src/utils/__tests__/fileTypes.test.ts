import { describe, expect, it } from 'vitest';
import {
  extensionsToAcceptString,
  extensionsToMimeTypes,
  getSupportedExtensions,
} from '../fileTypes';

describe('file type settings', () => {
  it('keeps configured supported extensions for the upload hint', () => {
    expect(getSupportedExtensions('jpg, dng, heic, heif, mov, mp4, .webp')).toEqual([
      'jpg',
      'dng',
      'heic',
      'heif',
      'mov',
      'mp4',
      'webp',
    ]);
  });

  it('uses the same configured types for validation and file selection', () => {
    expect(extensionsToMimeTypes('jpg,jpeg,dng,heic,heif,mov,mp4')).toEqual([
      'image/jpeg',
      'image/x-adobe-dng',
      'image/heic',
      'image/heif',
      'video/quicktime',
      'video/mp4',
    ]);
    expect(extensionsToAcceptString('dng,heic,heif')).toBe(
      'image/x-adobe-dng,image/heic,image/heif'
    );
  });

  it('falls back to the default formats when no configured types are supported', () => {
    expect(getSupportedExtensions('unknown')).toEqual([
      'jpg',
      'jpeg',
      'png',
      'webp',
    ]);
  });
});

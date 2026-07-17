import { describe, expect, it } from 'vitest';
import {
  extensionsToAcceptString,
  extensionsToMimeTypes,
  getSupportedExtensions,
} from '../fileTypes';

describe('file type settings', () => {
  it('keeps configured supported extensions for the upload hint', () => {
    expect(getSupportedExtensions('jpg, mov, mp4, .webp')).toEqual([
      'jpg',
      'mov',
      'mp4',
      'webp',
    ]);
  });

  it('uses the same configured types for validation and file selection', () => {
    expect(extensionsToMimeTypes('jpg,jpeg,mov,mp4')).toEqual([
      'image/jpeg',
      'video/quicktime',
      'video/mp4',
    ]);
    expect(extensionsToAcceptString('jpg,jpeg,mov,mp4')).toBe(
      'image/jpeg,video/quicktime,video/mp4'
    );
  });

  it('falls back to the default formats when no configured types are supported', () => {
    expect(getSupportedExtensions('dng,unknown')).toEqual([
      'jpg',
      'jpeg',
      'png',
      'webp',
    ]);
  });
});

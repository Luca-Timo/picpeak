import { describe, it, expect } from 'vitest';
import { extensionsToMimeTypes, extensionsToAcceptString, extensionsToLabel } from '../fileTypes';

describe('fileTypes', () => {
  describe('extensionsToMimeTypes', () => {
    it('maps known extensions to MIME types', () => {
      expect(extensionsToMimeTypes('jpg,png,mov')).toEqual(['image/jpeg', 'image/png', 'video/quicktime']);
    });
    it('supports HEIC/HEIF (#821)', () => {
      expect(extensionsToMimeTypes('heic,heif')).toEqual(['image/heic', 'image/heif']);
    });
    it('supports DNG (#821)', () => {
      expect(extensionsToMimeTypes('dng')).toEqual(['image/x-adobe-dng']);
    });
    it('drops unknown extensions and falls back to default when nothing maps', () => {
      expect(extensionsToMimeTypes('abc,xyz')).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    });
  });

  describe('extensionsToLabel', () => {
    it('renders a de-duplicated, upper-cased list of the configured formats', () => {
      expect(extensionsToLabel('jpg,jpeg,png,webp,mov')).toBe('JPG, JPEG, PNG, WEBP, MOV');
    });
    it('only lists supported extensions (drops unknowns like xyz)', () => {
      expect(extensionsToLabel('jpg,png,xyz')).toBe('JPG, PNG');
    });
    it('falls back to the default set when empty', () => {
      expect(extensionsToLabel('')).toBe('JPG, JPEG, PNG, WEBP');
      expect(extensionsToLabel(null)).toBe('JPG, JPEG, PNG, WEBP');
    });
  });

  describe('extensionsToAcceptString', () => {
    it('joins MIME types for the input accept attribute', () => {
      expect(extensionsToAcceptString('jpg,heic')).toBe('image/jpeg,image/heic');
    });
  });
});

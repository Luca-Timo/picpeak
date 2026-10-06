import type { ThemeConfig } from '../types/theme.types';
import { contrastRatio, relativeLuminance } from './contrast';
import { DARK_SURFACE_DEFAULTS, LIGHT_SURFACE_DEFAULTS } from './themeMigration';

// relativeLuminance() reads anything it can't parse as black; only infer
// the mode from colours it can actually read.
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface EmailBrandingColors {
  primary: string;
  secondary: string;
  bodyBg: string;
  containerBg: string;
  listBg: string;
  bodyText: string;
  mutedText: string;
}

/**
 * Map the active Branding theme onto the email palette (Settings → Email →
 * "Sync from Branding").
 *
 * Tokens the stored theme doesn't carry fall back to the defaults of the
 * theme's own colour mode. Themes saved before the 8-token palette have no
 * elevatedColor, and the old light-only fallbacks turned a dark theme into
 * a dark email card with a near-white info panel under near-white text.
 * When colorMode is unset or 'auto', the mode is read off the theme's
 * background (or surface) colour.
 */
export function emailColorsFromBranding(theme: ThemeConfig | null | undefined): EmailBrandingColors {
  const t = theme || {};
  const base = t.backgroundColor || t.surfaceColor;
  const isDark = t.colorMode === 'dark'
    || (t.colorMode !== 'light' && !!base && HEX.test(base.trim()) && relativeLuminance(base) < 0.5);
  const defaults = isDark ? DARK_SURFACE_DEFAULTS : LIGHT_SURFACE_DEFAULTS;
  const surface = t.surfaceColor || defaults.surfaceColor;

  return {
    primary: t.accentDarkColor || t.primaryColor || '#5C8762',
    secondary: surface,
    bodyBg: t.backgroundColor || defaults.backgroundColor,
    containerBg: surface,
    listBg: t.elevatedColor || defaults.elevatedColor,
    bodyText: t.textColor || defaults.textColor,
    mutedText: t.mutedTextColor || defaults.mutedTextColor,
  };
}

/**
 * The contrast ratio of body text on the info panel when it is below WCAG
 * AA (4.5:1), else null. The email wrapper swaps the panel text to a
 * readable neutral in that case; the settings page warns about it. Colours
 * that aren't plain hex (rgb(), named) return null, so no warning shows.
 */
export function lowListPanelContrast(bodyText: string, listBg: string): number | null {
  if (!HEX.test(bodyText.trim()) || !HEX.test(listBg.trim())) return null;
  const ratio = contrastRatio(bodyText, listBg);
  return ratio < 4.5 ? ratio : null;
}

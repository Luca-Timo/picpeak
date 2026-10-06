/**
 * WCAG 2.x colour contrast helpers.
 *
 * Shared by the PDF theme warnings and the email wrapper, which picks a
 * readable text colour for the info panel when the admin's palette puts
 * light text on a light panel (or dark on dark), and a footer divider that
 * doesn't glow on a dark palette.
 *
 * Only #rgb / #rrggbb (alpha ignored) and rgb()/rgba() are parsed. Anything
 * else — a named colour, hsl() — returns null so callers keep the colour
 * the admin chose instead of guessing.
 */

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;

function parseColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const hex = trimmed.match(HEX);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = digits.split('').map((d) => d + d).join('');
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }
  const rgb = trimmed.match(RGB);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map(Number);
    if (r > 255 || g > 255 || b > 255) return null;
    return { r, g, b };
  }
  return null;
}

/** WCAG relative luminance, or null when the colour can't be parsed. */
function relativeLuminance(value) {
  const rgb = parseColor(value);
  if (!rgb) return null;
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio (1–21), or null when either colour can't be parsed. */
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const DARK_TEXT = '#333333';
const LIGHT_TEXT = '#f5f5f5';

/**
 * The text colour to paint on `background`: `preferred` when it reaches
 * `minRatio`, otherwise whichever of a dark or light neutral reads better.
 * Unparseable input returns `preferred` unchanged.
 */
function readableTextOn(background, preferred, minRatio = 4.5) {
  const current = contrastRatio(preferred, background);
  if (current === null || current >= minRatio) return preferred;
  return contrastRatio(DARK_TEXT, background) >= contrastRatio(LIGHT_TEXT, background)
    ? DARK_TEXT
    : LIGHT_TEXT;
}

const DEFAULT_DIVIDER = '#eeeeee';

/**
 * The colour for a 1px divider drawn on `background`. Light (and
 * unparseable) backgrounds keep the long-standing #eeeeee; on a dark
 * background that would be a bright stripe, so the divider becomes the
 * background lifted 10% towards white — the same hue, just visible.
 */
function dividerOn(background) {
  const rgb = parseColor(background);
  if (!rgb || relativeLuminance(background) >= 0.2) return DEFAULT_DIVIDER;
  const lift = (c) => Math.round(c + (255 - c) * 0.1).toString(16).padStart(2, '0');
  return `#${lift(rgb.r)}${lift(rgb.g)}${lift(rgb.b)}`;
}

module.exports = { parseColor, relativeLuminance, contrastRatio, readableTextOn, dividerOn };

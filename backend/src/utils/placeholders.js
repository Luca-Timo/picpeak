'use strict';

/**
 * Allowlisted `{{key}}` placeholders for CRM document texts (#1451).
 *
 * Same grammar as the email templates (emailProcessor.safeTemplateReplace):
 * `{{key}}` with a plain word as the key, so there is no property traversal,
 * no function call and no code. The difference is the allowlist: a document
 * text may only use the keys its document type declares, and anything else is
 * reported, so a template can't be published with a typo that would print
 * "{{custmer_name}}" on every quote.
 *
 * Values are escaped for the output they land in: `text` (PDF, plain-text
 * mail, the editor textarea) leaves them as they are, `html` escapes them.
 */

const { escapeHtml } = require('./formatters');

const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;
// `{{#if key}}…{{/if}}` — contract bodies use it to leave a clause out when
// a value is missing. Same tolerance for spaces as the plain placeholder, and
// the same module owns both so the check and the renderer can't disagree
// about what a placeholder looks like.
const CONDITIONAL_PATTERN = /\{\{\s*#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/g;

// Keys a quote text (intro/outro, text blocks) may use.
const QUOTE_PLACEHOLDERS = Object.freeze([
  'customer_name',
  'customer_company',
  'event_name',
  'event_date',
  'quote_number',
  'valid_until',
  'business_name',
  'hours',
  'days',
  'hourly_rate',
  'day_rate',
]);

/** Every placeholder key used in `text`, in order of first appearance. */
// Keys contract texts may use (#1445) — the values
// services/contract/renderContext.buildPlaceholderContext provides.
const CONTRACT_PLACEHOLDERS = Object.freeze([
  'customer_name',
  'customer_address',
  'event_name',
  'event_date',
  'issue_date',
  'contract_number',
  'title',
  'net_days',
  'skonto_percent',
  'skonto_within_days',
  'cancellation_30d_percent',
  'currency',
  'issuer_company_name',
  'issuer_address',
  'source_quote_number',
]);

function findPlaceholders(text) {
  if (typeof text !== 'string' || !text) return [];
  const keys = [];
  // Conditionals first: `{{#if event_date}}` names a key too, and a typo in
  // one used to publish without a word — the clause then simply never
  // appeared on any document.
  for (const match of text.matchAll(CONDITIONAL_PATTERN)) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/**
 * Does `text` use a `{{#if …}}` block? Quote texts are rendered by
 * renderPlaceholders, which resolves plain placeholders only, so a
 * conditional there would publish cleanly and then print its markup on the
 * quote. Contract bodies go through renderTemplatedBody and do support them.
 */
function hasConditional(text) {
  if (typeof text !== 'string' || !text) return false;
  return new RegExp(CONDITIONAL_PATTERN.source).test(text);
}

/**
 * Resolve `{{#if key}}…{{/if}}` against `values`: a key with no value — a
 * missing one included — drops the block. A plain `{{key}}` stays visible
 * when it is unknown, but leaving `{{#if …}}` markup in a contract body
 * would print it on the document, so a typo is caught earlier instead:
 * findPlaceholders reports conditional keys too, and publishing a template
 * with an unknown one is refused.
 */
function renderConditionals(text, values = {}) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(CONDITIONAL_PATTERN, (match, key, inner) => {
    const value = values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    const present = value !== undefined && value !== null && value !== '' && value !== false && value !== 0;
    return present ? inner : '';
  });
}

/** Placeholder keys in `text` that are not in `allowlist`. */
function unknownPlaceholders(text, allowlist = QUOTE_PLACEHOLDERS) {
  return findPlaceholders(text).filter((key) => !allowlist.includes(key));
}

/**
 * Replace allowlisted placeholders with `values[key]`. A known key without a
 * value becomes an empty string (a quote without an event date simply has no
 * date); an unknown key is left untouched, so it stays visible instead of
 * silently disappearing.
 *
 * @param {string} text
 * @param {object} values
 * @param {{allowlist?: string[], output?: 'text'|'html'}} [options]
 */
function renderPlaceholders(text, values = {}, { allowlist = QUOTE_PLACEHOLDERS, output = 'text' } = {}) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(PLACEHOLDER_PATTERN, (match, key) => {
    if (!allowlist.includes(key)) return match;
    // Own properties only — never a value inherited from Object.prototype.
    const value = values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    if (value == null) return '';
    const str = String(value);
    return output === 'html' ? escapeHtml(str) : str;
  });
}

module.exports = {
  QUOTE_PLACEHOLDERS,
  CONTRACT_PLACEHOLDERS,
  PLACEHOLDER_PATTERN,
  CONDITIONAL_PATTERN,
  findPlaceholders,
  hasConditional,
  renderConditionals,
  unknownPlaceholders,
  renderPlaceholders,
};

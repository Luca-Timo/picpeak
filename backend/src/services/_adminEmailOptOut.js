'use strict';

/**
 * Per-customer "no administrative emails" (migration 299).
 *
 * Some customers only want the amount and will transfer the money; they do
 * not want quote, contract or invoice mail. For those customers the CRM still
 * issues every document as usual (numbered, stored, in the tax report, and in
 * the customer portal when they have access) — only the mail to the customer
 * is held back. A passive customer (no portal login) gets nothing digitally;
 * the admin hands the documents over, and a contract is signed on paper and
 * uploaded.
 *
 * The gate sits in emailProcessor.queueEmail and keys on the email type plus
 * the recipient address, so every send path (manual send, scheduled flush,
 * accept-on-behalf, reminders, workflow send_document) is covered without
 * each caller having to remember it. Matching on the recipient keeps other
 * people unaffected: a second contract signer or the business's own admin
 * notices still go out.
 */

const { db } = require('../database/db');
const { hasColumnCached } = require('../utils/schemaCache');

// Customer-facing CRM mail. Deliberately NOT listed: account mail
// (invitation, password reset), contract_signing_code (a one-time code the
// customer asked for while signing in the portal), gallery and transfer mail,
// and every *_admin notification addressed to the business.
const ADMINISTRATIVE_EMAIL_TYPES = new Set([
  'quote_sent',
  'quote_accepted_customer',
  'quote_addons_updated',
  'invoice_sent',
  'invoice_reminder_first',
  'invoice_reminder_second',
  'invoice_paid_receipt',
  'storno_issued',
  'contract_sent',
  'contract_signature_reminder',
  'contract_signature_received',
  'contract_fully_signed',
  'contract_data_request',
  'customer_document_shared',
  'customer_document_reviewed',
  'customer_document_requested',
  'customer_document_request_reminder',
]);

function isAdministrativeEmailType(emailType) {
  return ADMINISTRATIVE_EMAIL_TYPES.has(emailType);
}

/**
 * True when `recipientEmail` belongs to a customer who opted out of
 * administrative mail and `emailType` is one of those mails. Matches the
 * customer's login email and billing email, case-insensitively.
 *
 * An address can belong to more than one account (a shared billing inbox).
 * The mail is held back only when EVERY account at that address opted out:
 * one customer's switch must not silence another customer's invoices.
 */
async function isSuppressedForRecipient(recipientEmail, emailType) {
  if (!isAdministrativeEmailType(emailType)) return false;
  const address = String(recipientEmail || '').trim().toLowerCase();
  if (!address) return false;
  if (!(await hasColumnCached('customer_accounts', 'no_admin_emails'))) return false;
  const matches = await db('customer_accounts')
    .where((q) => {
      q.whereRaw('LOWER(email) = ?', [address]).orWhereRaw('LOWER(billing_email) = ?', [address]);
    })
    .select('no_admin_emails');
  return matches.length > 0 && matches.every((row) => row.no_admin_emails === true || row.no_admin_emails === 1);
}

module.exports = {
  ADMINISTRATIVE_EMAIL_TYPES,
  isAdministrativeEmailType,
  isSuppressedForRecipient,
};

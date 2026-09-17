/**
 * The payment-check link's expiry has to hold for every shape the column is
 * stored in.
 *
 * `invoice_payment_check_tokens.expires_at` is NOT NULL (migration 107), and
 * the reads used to be `row.expires_at && new Date(row.expires_at).getTime()
 * < Date.now()`: for a value that can't be parsed — and for a missing one —
 * that comparison is false, so the link kept working past its expiry instead
 * of being refused. PostgreSQL hands back a Date and production SQLite stores
 * a bare Date as epoch ms, both of which `new Date(...)` reads, so this is
 * hardening rather than a live bypass; the shape that isn't readable is the
 * one a service's `new Date()` produces under Jest, which is exactly why it
 * has to be pinned here.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let customerId;
let payments;
let sequence = 0;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ customerId } = await seedMinimal(db));
  payments = require('../../src/services/invoice/payments');
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);

async function invoiceWithToken(expiresAt) {
  sequence += 1;
  const invoiceId = idOf(await db('invoices').insert({
    invoice_number: `PAY-${sequence}`,
    customer_account_id: customerId,
    status: 'sent',
    issue_date: '2026-09-01',
    due_date: '2026-09-30',
    total_amount_minor: 10000,
  }).returning('id'));
  const token = `token-${sequence}-${'a'.repeat(50)}`;
  await db('invoice_payment_check_tokens').insert({
    invoice_id: invoiceId,
    token,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  });
  return { invoiceId, token };
}

const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.code || err.statusCode;
  }
};

test('a live link opens, in every shape the engines store', async () => {
  // ISO (what the service writes now) and epoch ms (what production SQLite
  // makes of a Date). A bare Date is in the unreadable case below, because
  // that is what it becomes in this suite.
  const inThreeDays = Date.now() + 72 * 60 * 60 * 1000;
  for (const shape of [new Date(inThreeDays).toISOString(), inThreeDays]) {
    const { token } = await invoiceWithToken(shape);
    const view = await payments.getPaymentCheckByToken(token);
    expect(view).toEqual(expect.objectContaining({ outstandingMinor: 10000 }));
  }
});

test('an expiry in the past is refused', async () => {
  const { token } = await invoiceWithToken(new Date(Date.now() - 60 * 1000).toISOString());
  expect(await codeOf(payments.getPaymentCheckByToken(token))).toBe('TOKEN_EXPIRED');
  expect(await codeOf(payments.recordPaymentCheckAction({ token, action: 'paid_full' }))).toBe('TOKEN_EXPIRED');
});

test('an expiry nothing can read is refused, not treated as no expiry at all', async () => {
  // What a bare `new Date()` from another realm becomes in SQLite, and what
  // a garbled or truncated value looks like: `new Date(x).getTime()` is NaN,
  // and `NaN < Date.now()` is false — so both reads let the link through.
  for (const unreadable of ['[object Object]', 'not a date', '', new Date(Date.now() + 72 * 60 * 60 * 1000)]) {
    const { token } = await invoiceWithToken(unreadable);
    expect(await codeOf(payments.getPaymentCheckByToken(token))).toBe('TOKEN_EXPIRED');
    expect(await codeOf(payments.recordPaymentCheckAction({ token, action: 'paid_full' }))).toBe('TOKEN_EXPIRED');
  }
});

test('the token the service writes is readable back', async () => {
  // queuePaymentCheckEmail writes the expiry; reading it back has to give a
  // time, or the check above has nothing to compare.
  const { toMillis } = require('../../src/utils/queueTimestamps');
  sequence += 1;
  const invoiceId = idOf(await db('invoices').insert({
    invoice_number: `PAY-Q-${sequence}`,
    customer_account_id: customerId,
    status: 'overdue',
    issue_date: '2026-08-01',
    due_date: '2026-08-15',
    total_amount_minor: 5000,
  }).returning('id'));
  const profile = await db('business_profile').first();
  if (profile) await db('business_profile').where({ id: profile.id }).update({ email: 'studio@example.com' });

  const result = await payments.queuePaymentCheckEmail(invoiceId, { adminId: null });
  expect(result.sent).toBe(true);

  const row = await db('invoice_payment_check_tokens').where({ invoice_id: invoiceId }).first();
  expect(Number.isFinite(toMillis(row.expires_at))).toBe(true);
  expect(toMillis(row.expires_at)).toBeGreaterThan(Date.now());
  // …and the link it just wrote opens.
  await expect(payments.getPaymentCheckByToken(row.token)).resolves.toBeTruthy();
});

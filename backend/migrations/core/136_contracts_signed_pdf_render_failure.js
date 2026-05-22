/**
 * Migration: add `contracts.signed_pdf_render_failed_at` +
 * `contracts.signed_pdf_render_error` so the silent post-sign re-stamp
 * failure mode becomes observable on the admin detail page.
 *
 * **The orphan state the audit flagged**
 *
 * `recordCustomerSignature` (and the admin counter-sign equivalent)
 * does two things:
 *
 *   1. Atomically persist the signature evidence + flip status to
 *      'signed_by_customer'.
 *   2. Stamp the signature PNG onto pdf_path and write a new
 *      signed_pdf_path file via pdf-lib.
 *
 * Step 2 is wrapped in try/catch — the only failure signal is a
 * `logger.error(...)` line. When step 2 throws (disk full, pdf-lib
 * blowing up on a malformed cert chain, file permission flip), the
 * contract row sits at status='signed_by_customer' with
 * signed_pdf_path=NULL forever. The customer's email notification
 * still fires; the admin has no UI cue. Admin discovers the orphan
 * only via monitoring or when they manually open the contract and
 * notice the missing download link.
 *
 * **Two columns, why**
 *
 *   - `signed_pdf_render_failed_at` (timestamp, nullable): NULL when
 *     the most recent stamp succeeded OR no stamp has been attempted.
 *     Populated when the latest attempt threw. Used by the admin
 *     detail surface to render a "PDF stamp failed — click to retry"
 *     banner.
 *
 *   - `signed_pdf_render_error` (text, nullable): the err.message
 *     truncated to 2 KB so the admin can see WHY without digging
 *     into server logs. Not the full stack — we don't want to expose
 *     filesystem layout in the API payload. Cleared on success
 *     alongside the timestamp.
 *
 * Both columns are nullable + default NULL. Existing rows are
 * unaffected by the migration. Recovery paths (`rerenderAndResend`
 * the `/resend-signed` admin route, `restampSignatures` the
 * `/restamp-signatures` route) become the documented retry mechanism;
 * each clears these columns on success.
 *
 * **Why not a single boolean**
 *
 * A boolean would lose the "when" + "why" forensic record. The
 * detail page surfaces a relative timestamp ("PDF stamp failed 12
 * minutes ago") so the admin can correlate with deploy / disk
 * events. Cheap insurance.
 */

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('contracts');
  if (!hasTable) return;
  const hasFailedAt = await knex.schema.hasColumn('contracts', 'signed_pdf_render_failed_at');
  const hasError = await knex.schema.hasColumn('contracts', 'signed_pdf_render_error');
  if (!hasFailedAt || !hasError) {
    await knex.schema.alterTable('contracts', (table) => {
      if (!hasFailedAt) table.timestamp('signed_pdf_render_failed_at').nullable().defaultTo(null);
      if (!hasError) table.text('signed_pdf_render_error').nullable().defaultTo(null);
    });
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('contracts');
  if (!hasTable) return;
  await knex.schema.alterTable('contracts', (table) => {
    table.dropColumn('signed_pdf_render_failed_at');
    table.dropColumn('signed_pdf_render_error');
  });
};

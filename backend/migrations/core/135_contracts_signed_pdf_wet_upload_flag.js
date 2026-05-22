/**
 * Migration: add `contracts.signed_pdf_is_wet_upload` boolean so the
 * service layer can identify wet-signed (operator-uploaded) PDFs
 * without resorting to substring matching on the file path.
 *
 * **Why the substring check was wrong**
 *
 * `contractService.js` previously detected wet uploads via
 * `path.includes('uploads/contracts/signed')`. Three failure modes:
 *
 *   1. If the deployment's storage root is renamed (env var change,
 *      Docker volume re-mount, admin reorganisation), every wet
 *      upload looks like a system-rendered PDF. The very next
 *      "re-stamp on counter-sign" code path overwrites
 *      `signed_pdf_path` with a fresh stamped copy of the unsigned
 *      base — losing the authoritative customer-signed bytes.
 *
 *   2. An attacker who can influence the upload directory (rare,
 *      but conceivable through a misconfigured proxy/symlink) could
 *      either bypass the wet-upload protection (rename the dir so
 *      uploads look system-produced and get overwritten) or trip it
 *      false-positive (write a system PDF into a path containing
 *      that substring and prevent further legitimate re-stamps).
 *
 *   3. Code reviewers can't tell from the schema whether a
 *      signed_pdf_path row is authoritative. It's encoded entirely
 *      in the disk-path convention, which is a fragile invariant
 *      to depend on.
 *
 * **What this column captures**
 *
 * One boolean per contract: TRUE when `signed_pdf_path` points at a
 * wet upload that must NEVER be overwritten by automatic re-stamps,
 * FALSE when the file is a system-stamped copy that re-stamping can
 * safely replace.
 *
 * Set by `attachSignedPdfUpload` (the wet-upload entry point) to
 * TRUE; defaulted FALSE on every other write to `signed_pdf_path`.
 *
 * **Backfill**
 *
 * Existing rows: project the old substring rule forward at apply
 * time. Any contract whose `signed_pdf_path` includes
 * `uploads/contracts/signed` gets the flag set; everything else
 * stays FALSE. Identical semantics to what the service did before,
 * just persisted instead of recomputed on every call. After this
 * migration, future code paths trust the column exclusively.
 */

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('contracts');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('contracts', 'signed_pdf_is_wet_upload');
  if (!hasColumn) {
    await knex.schema.alterTable('contracts', (table) => {
      table.boolean('signed_pdf_is_wet_upload').notNullable().defaultTo(false);
    });
  }

  // Project the old substring rule onto existing rows so behaviour
  // doesn't shift on upgrade. Use the literal `LIKE` SQL form rather
  // than a JS loop because the contracts table can be large on busy
  // installs and we want a single statement.
  await knex('contracts')
    .whereNotNull('signed_pdf_path')
    .where('signed_pdf_path', 'like', '%uploads/contracts/signed%')
    .update({ signed_pdf_is_wet_upload: true });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('contracts');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('contracts', 'signed_pdf_is_wet_upload');
  if (hasColumn) {
    await knex.schema.alterTable('contracts', (table) => {
      table.dropColumn('signed_pdf_is_wet_upload');
    });
  }
};

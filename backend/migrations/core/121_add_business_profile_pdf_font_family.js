/**
 * Migration: business_profile.pdf_font_family
 *
 * Drives the new "PDF font" dropdown on Settings → Branding. Stores
 * the bundled-fonts directory name (e.g. "Inter", "Playfair-Display")
 * so pdfService.createBaseDocument can register
 * `backend/assets/fonts/<family>/400.ttf` (body) and
 * `<family>/700.ttf` (bold) at PDF time.
 *
 * Existing `pdf_font_ttf_path` column from migration 103 stays in
 * place. pdfService prefers it as the priority-1 override (so any
 * admin who manually populated it via SQL/seed keeps that
 * behaviour). The UI for setting `pdf_font_ttf_path` is being
 * removed in the same PR — the new dropdown is the way forward.
 *
 * Nullable: NULL = "no preference, fall back to Helvetica" which
 * matches the historical default. No backfill needed.
 *
 * Idempotent: hasTable + hasColumn guards so it's safe to re-run.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  if (await knex.schema.hasColumn('business_profile', 'pdf_font_family')) return;
  await knex.schema.alterTable('business_profile', (table) => {
    table.string('pdf_font_family', 128).nullable();
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  if (!(await knex.schema.hasColumn('business_profile', 'pdf_font_family'))) return;
  await knex.schema.alterTable('business_profile', (table) => {
    table.dropColumn('pdf_font_family');
  });
};

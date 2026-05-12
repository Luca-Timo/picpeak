/**
 * Migration: business_profile.pdf_font_ttf_path
 *
 * Adds a single column so admins can point the PDF renderer at a
 * custom TTF/OTF file uploaded under storage/uploads/. PDFKit only
 * understands TTF/OTF (the bundled webfonts under assets/fonts/ are
 * woff2 and can't be loaded directly).
 *
 * When set, pdfService.renderDocument calls doc.registerFont() with
 * this path and uses it for FONT_BODY + FONT_BOLD. When unset (or the
 * file is missing) the renderer falls back to Helvetica.
 *
 * Why a follow-up migration and not an edit-in-place to 102:
 *   - migration 102 already shipped via PR-80 and was reverted then
 *     re-applied, so the row is live on production
 *   - knex tracks migrations by filename, so editing 102 would not
 *     re-run on existing DBs
 *   - per project policy, this is a real new feature on already-
 *     deployed infrastructure — exactly the case where a follow-up
 *     migration is the correct shape
 *
 * Idempotent — checks for the column before adding.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  const exists = await knex.schema.hasColumn('business_profile', 'pdf_font_ttf_path');
  if (exists) return;
  await knex.schema.alterTable('business_profile', (table) => {
    // Absolute path or relative to storage/. Nullable — most installs
    // won't set this and the renderer falls back to Helvetica.
    table.string('pdf_font_ttf_path', 512);
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  if (!(await knex.schema.hasColumn('business_profile', 'pdf_font_ttf_path'))) return;
  await knex.schema.alterTable('business_profile', (table) => {
    table.dropColumn('pdf_font_ttf_path');
  });
};

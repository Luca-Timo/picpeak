/**
 * contractBlocksService — CRUD for the contract block library.
 *
 * The library is shared across all contracts. System blocks (12 seeded
 * by migration 130) cannot be deleted but their body text remains
 * editable so the admin's lawyer can rewrite them. Admin-authored
 * (non-system) blocks can be freely created, edited, and removed.
 *
 * Sections are validated against a fixed enum mirroring
 * contractService.SECTIONS_ORDER — keeping these in sync is the
 * "data-driven all the way down" guarantee (no orphan sections in
 * the DB that the renderer can't display).
 */

const { db, withRetry } = require('../database/db');
const { AppError } = require('../utils/errors');

const ALLOWED_SECTIONS = ['basics', 'scope', 'privacy', 'commercial', 'nda', 'closing'];

function ensureSection(section) {
  if (!ALLOWED_SECTIONS.includes(section)) {
    throw new AppError(
      `Invalid section '${section}'. Must be one of: ${ALLOWED_SECTIONS.join(', ')}`,
      400,
      'INVALID_SECTION',
    );
  }
}

function slugify(name) {
  const base = String(name || 'block')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  // Append a 6-hex suffix so admin-authored blocks don't collide with
  // each other or with seeded slugs.
  const suffix = require('crypto').randomBytes(3).toString('hex');
  return `${base || 'block'}_${suffix}`;
}

async function listBlocks({ section, includeInactive = false } = {}) {
  return await withRetry(async () => {
    let q = db('contract_blocks').select('*');
    if (section) q = q.where({ section });
    if (!includeInactive) q = q.where({ is_active: true });
    q = q.orderBy('section', 'asc').orderBy('display_order', 'asc').orderBy('id', 'asc');
    return await q;
  });
}

async function getBlockById(id) {
  return await db('contract_blocks').where({ id }).first();
}

async function createBlock(payload) {
  if (!payload.name || !String(payload.name).trim()) {
    throw new AppError('Block name is required', 400);
  }
  ensureSection(payload.section);
  if (!payload.bodyText || !String(payload.bodyText).trim()) {
    throw new AppError('Block body (EN) is required', 400);
  }

  const slug = payload.slug && /^[a-z0-9_]+$/.test(payload.slug)
    ? payload.slug
    : slugify(payload.name);

  // Ensure slug uniqueness (regenerate on the rare collision).
  let finalSlug = slug;
  let attempt = 0;
  while (await db('contract_blocks').where({ slug: finalSlug }).first()) {
    attempt += 1;
    finalSlug = slugify(payload.name);
    if (attempt > 5) {
      throw new AppError('Could not generate a unique block slug', 500);
    }
  }

  const row = {
    slug: finalSlug,
    section: payload.section,
    name: String(payload.name).trim().slice(0, 128),
    description: payload.description ? String(payload.description).slice(0, 255) : null,
    body_text: String(payload.bodyText),
    body_text_de: payload.bodyTextDe ? String(payload.bodyTextDe) : null,
    is_system: false,
    is_active: payload.isActive !== false,
    display_order: Number.isFinite(payload.displayOrder) ? Number(payload.displayOrder) : 100,
    created_at: new Date(),
    updated_at: new Date(),
  };
  // Schema-drift guard — migration 131 adds these columns. On installs
  // that haven't migrated yet, only EN+DE bodies persist; the other
  // four fields are accepted from the payload but silently dropped.
  for (const [field, payloadKey] of [
    ['body_text_ru', 'bodyTextRu'],
    ['body_text_pt', 'bodyTextPt'],
    ['body_text_nl', 'bodyTextNl'],
    ['body_text_fr', 'bodyTextFr'],
  ]) {
    if (payload[payloadKey] != null
        && await db.schema.hasColumn('contract_blocks', field)) {
      row[field] = payload[payloadKey] ? String(payload[payloadKey]) : null;
    }
  }

  const inserted = await db('contract_blocks').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return await getBlockById(id);
}

/**
 * Update a block. System blocks: every field is editable so the
 * admin's lawyer can rewrite the body text in place. The only
 * protection on system blocks is that they can't be hard-deleted —
 * an admin who wants to retire one toggles `is_active=false`.
 */
async function updateBlock(id, payload) {
  const existing = await getBlockById(id);
  if (!existing) throw new AppError('Block not found', 404);

  const updates = { updated_at: new Date() };
  if ('section' in payload) {
    ensureSection(payload.section);
    updates.section = payload.section;
  }
  if ('name' in payload) {
    if (!payload.name || !String(payload.name).trim()) {
      throw new AppError('Block name is required', 400);
    }
    updates.name = String(payload.name).trim().slice(0, 128);
  }
  if ('description' in payload) {
    updates.description = payload.description ? String(payload.description).slice(0, 255) : null;
  }
  if ('bodyText' in payload) {
    if (!payload.bodyText || !String(payload.bodyText).trim()) {
      throw new AppError('Block body (EN) is required', 400);
    }
    updates.body_text = String(payload.bodyText);
  }
  if ('bodyTextDe' in payload) {
    updates.body_text_de = payload.bodyTextDe ? String(payload.bodyTextDe) : null;
  }
  // Same schema-drift guard as createBlock — accept ru/pt/nl/fr only
  // when the column actually exists, so beta installs running this
  // service against a not-yet-migrated DB don't throw.
  for (const [field, payloadKey] of [
    ['body_text_ru', 'bodyTextRu'],
    ['body_text_pt', 'bodyTextPt'],
    ['body_text_nl', 'bodyTextNl'],
    ['body_text_fr', 'bodyTextFr'],
  ]) {
    if (payloadKey in payload
        && await db.schema.hasColumn('contract_blocks', field)) {
      updates[field] = payload[payloadKey] ? String(payload[payloadKey]) : null;
    }
  }
  if ('isActive' in payload) {
    updates.is_active = payload.isActive !== false;
  }
  if ('displayOrder' in payload && Number.isFinite(payload.displayOrder)) {
    updates.display_order = Number(payload.displayOrder);
  }

  await db('contract_blocks').where({ id }).update(updates);
  return await getBlockById(id);
}

/**
 * Hard-delete an admin-authored block. System blocks refuse delete —
 * the admin must `deactivate` (toggle `is_active=false`) instead.
 *
 * Active inclusions on existing contracts are protected by the FK
 * ON DELETE RESTRICT — deleting a block that's still referenced will
 * raise a DB error which we catch and surface as a clean 409.
 */
async function deleteBlock(id) {
  const existing = await getBlockById(id);
  if (!existing) throw new AppError('Block not found', 404);
  if (existing.is_system) {
    throw new AppError(
      'System blocks cannot be deleted. Toggle them inactive instead so they remain available for audit on old contracts.',
      409,
      'SYSTEM_BLOCK_PROTECTED',
    );
  }
  try {
    await db('contract_blocks').where({ id }).del();
  } catch (err) {
    if (/foreign key|FOREIGN KEY|RESTRICT/i.test(err.message)) {
      throw new AppError(
        'This block is referenced by one or more contracts. Toggle it inactive instead of deleting.',
        409,
        'BLOCK_IN_USE',
      );
    }
    throw err;
  }
  return { id };
}

module.exports = {
  listBlocks,
  getBlockById,
  createBlock,
  updateBlock,
  deleteBlock,
  ALLOWED_SECTIONS,
};

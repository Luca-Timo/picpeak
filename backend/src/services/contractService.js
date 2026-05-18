/**
 * contractService — orchestrates the lifecycle of `contracts`, their
 * `contract_block_inclusions` (which blocks from the library make it
 * onto a given contract), and the public `contract_action_tokens` used
 * by the customer's signing link.
 *
 * Contracts are an INDEPENDENT document type alongside quotes and
 * invoices. Composition model:
 *   - Admin picks blocks from the `contract_blocks` library and toggles
 *     them on/off per section (basics → scope → privacy → commercial →
 *     nda → closing). Order within a section is admin-controlled.
 *   - On send, every included block's body is FROZEN into
 *     `body_text_snapshot` on the inclusion row, so future edits to
 *     the source block don't mutate already-sent contracts.
 *
 * Signing:
 *   1. Customer opens /contract/:token and either:
 *      a) Types name, optionally draws a signature on canvas, ticks
 *         "I have read and agree", submits → recordCustomerSignature
 *         stamps the signature into a re-rendered PDF and the system
 *         emails the admin.
 *      b) Uploads a wet-signed PDF → attachSignedPdfUpload sets the
 *         signed_pdf_path as the authoritative copy.
 *   2. Admin counter-signs (in-browser or by re-uploading the
 *      double-signed PDF) → status flips to `fully_signed`.
 *
 * Bodies support {{placeholders}} resolved at PDF/preview render time
 * using the same Handlebars-lite regex that emailProcessor.safeTemplateReplace
 * uses. We rebuild it inline here (not exported from emailProcessor) to
 * keep the dependency tree shallow and so contracts can render
 * client-side previews in the future without pulling the email
 * processor.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, withRetry, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { AppError } = require('../utils/errors');
const businessProfileService = require('./businessProfileService');
const pdfService = require('./pdfService');
const emailProcessor = require('./emailProcessor');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');

const SECTIONS_ORDER = ['basics', 'scope', 'privacy', 'commercial', 'nda', 'closing'];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function ensureInt(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return 0;
  return n;
}

function formatNumberInTemplate(format, year, seq) {
  return format
    .replace(/\{YEAR\}/g, String(year))
    .replace(/\{MONTH\}/g, String(new Date().getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ:(\d+)d\}/g, (_, pad) => String(seq).padStart(parseInt(pad, 10), '0'))
    .replace(/\{SEQ\}/g, String(seq));
}

/**
 * Gap-free per-year contract number sequence. Same shape as
 * nextQuoteNumber / nextInvoiceNumber so format tokens are consistent.
 */
async function nextContractNumber() {
  const format = (await getAppSetting('crm_contracts_number_format')) || 'C-{YEAR}-{SEQ:04d}';
  const year = new Date().getFullYear();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const yearPrefix = formatNumberInTemplate(format, year, 0).slice(0, -4);
    const rows = await db('contracts')
      .where('contract_number', 'like', `${yearPrefix}%`)
      .select('contract_number');
    let maxSeq = 0;
    for (const r of rows) {
      const m = r.contract_number.match(/(\d+)\s*$/);
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
    const candidate = formatNumberInTemplate(format, year, maxSeq + 1);
    const exists = await db('contracts').where({ contract_number: candidate }).first();
    if (!exists) return candidate;
  }
  return `C-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * Handlebars-lite renderer:
 *   - `{{#if var}}…{{/if}}` blocks resolved by truthiness of variables[var].
 *   - `{{var}}` substituted with the matching variable. Missing
 *     placeholders are left literally as `{{var}}` so the admin
 *     notices the unresolved field in preview.
 *
 * Mirrors safeTemplateReplace in emailProcessor.js (lines 424-461) but
 * without HTML escaping — contract bodies are rendered into PDF via
 * pdfService.drawText, which doesn't need HTML safety.
 */
function renderTemplatedBody(template, variables) {
  if (typeof template !== 'string' || template.length === 0) return template;
  const conditionalsResolved = template.replace(
    /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key, inner) => {
      const v = variables ? variables[key] : undefined;
      const truthy = v !== undefined && v !== null && v !== '' && v !== false && v !== 0;
      return truthy ? inner : '';
    }
  );
  return conditionalsResolved.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!variables || !Object.prototype.hasOwnProperty.call(variables, key)) return match;
    return String(variables[key]);
  });
}

/**
 * Build the variable bag used by renderTemplatedBody. Reads the
 * customer record, business profile, and (when available) the
 * customer's active payment-term defaults so block placeholders for
 * net_days / skonto_percent / etc. resolve. Returns plain strings —
 * dates formatted DD.MM.YYYY in DE-CH style, numbers as-is.
 */
async function buildPlaceholderContext(contract, customer) {
  const profile = (await businessProfileService.getProfile()).profile || {};
  const issuerCompany = profile.company_name || '';
  const issuerAddress = [profile.address_line1, profile.postal_code, profile.city]
    .filter(Boolean)
    .join(', ');

  // Resolve net_days + skonto from app_settings defaults so the
  // payment_terms_reference block has sensible numbers to substitute
  // when the admin hasn't tied the contract to a specific quote.
  const netDaysDefault = ensureInt(await getAppSetting('crm_payment_default_net_days')) || 30;
  const skontoPercentDefault = await getAppSetting('crm_invoices_skonto_percent_default');
  const skontoWithinDaysDefault = ensureInt(await getAppSetting('crm_invoices_skonto_business_days')) || 5;

  const customerName = customer
    ? (customer.company_name
        || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
        || customer.display_name
        || customer.email
        || '')
    : '';
  const customerAddress = customer
    ? [customer.address_line1, customer.address_line2, customer.postal_code, customer.city]
        .filter(Boolean)
        .join(', ')
    : '';

  return {
    customer_name: customerName,
    customer_address: customerAddress,
    event_name: contract.event_name || '',
    event_date: formatShortDate(contract.event_date),
    issue_date: formatShortDate(contract.issue_date),
    contract_number: contract.contract_number || '',
    title: contract.title || '',
    net_days: String(netDaysDefault),
    skonto_percent: skontoPercentDefault == null ? '0' : String(skontoPercentDefault),
    skonto_within_days: String(skontoWithinDaysDefault),
    cancellation_30d_percent: '25',
    currency: (profile.default_currency || 'CHF').toUpperCase(),
    issuer_company_name: issuerCompany,
    issuer_address: issuerAddress,
  };
}

function formatShortDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

async function persistContractPdf(contract, buffer, suffix = '') {
  if (!contract.contract_number) return null;
  const year = (contract.issue_date ? new Date(contract.issue_date) : new Date()).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'contract', String(year));
  fs.mkdirSync(root, { recursive: true });
  const fileName = suffix
    ? `${contract.contract_number}_${suffix}.pdf`
    : `${contract.contract_number}.pdf`;
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function persistSignatureImage(contract, role, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) {
    throw new AppError('Signature must be a base64-encoded PNG or JPEG data URL', 400, 'BAD_SIGNATURE_FORMAT');
  }
  const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
  const root = path.join(
    process.cwd(),
    'storage',
    'business-docs',
    'contract',
    'signatures',
    String(contract.id),
  );
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, `${role}-${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return filePath;
}

function ensureCustomerActive(customer) {
  if (!customer) throw new AppError('Customer not found', 404);
  if (customer.is_active === false || customer.is_active === 0) {
    throw new AppError('Customer is deactivated', 409);
  }
}

// ---------------------------------------------------------------------
// Render-context builder + PDF helpers
// ---------------------------------------------------------------------

/**
 * Build the data shape pdfService.renderContractToBuffer expects.
 * Sections are emitted in canonical SECTIONS_ORDER; blocks within a
 * section are emitted in `position` order. Bodies are run through
 * renderTemplatedBody so {{placeholders}} are substituted.
 *
 * When the contract has been sent, `body_text_snapshot` is used (so
 * later edits to the source block don't mutate the rendered document).
 * Before send (preview from editor) the live `contract_blocks.body_text`
 * is used so the admin can iterate on block bodies and see the result.
 */
async function buildRenderContext(contract, inclusions) {
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  const profile = (await businessProfileService.getProfile()).profile || {};
  const placeholders = await buildPlaceholderContext(contract, customer);

  const locale = contract.language || customer?.preferred_language || profile.default_locale || 'de';

  // Group inclusions by section + render each block body.
  const blocksBySection = {};
  for (const section of SECTIONS_ORDER) blocksBySection[section] = [];
  const sortedInclusions = [...inclusions]
    .filter((row) => row.included === true || row.included === 1 || row.included === '1')
    .sort((a, b) => {
      const sa = SECTIONS_ORDER.indexOf(a.section);
      const sb = SECTIONS_ORDER.indexOf(b.section);
      if (sa !== sb) return sa - sb;
      return (a.position || 0) - (b.position || 0);
    });

  for (const row of sortedInclusions) {
    if (!blocksBySection[row.section]) continue;
    // The inclusion row carries the JOINED block columns aliased with
    // a `block_` prefix (see getContractById). Pre-send drafts have
    // null snapshots, so fall through to the live block body.
    const bodyEn = row.body_text_snapshot || row.block_body_text || '';
    const bodyDe = row.body_text_de_snapshot || row.block_body_text_de || '';
    const sourceBody = locale === 'de' ? (bodyDe || bodyEn) : (bodyEn || bodyDe);
    // Substitute placeholders, then strip `**bold**` markdown markers
    // so they don't leak into the PDF literally. The block's name
    // already provides the bold sub-heading, so the leading
    // `**Title**` line in seeded bodies is decorative; admins can
    // still use ** in custom blocks — the markers are quietly
    // removed at render time.
    const rendered = renderTemplatedBody(sourceBody, placeholders)
      .replace(/\*\*([^*]+)\*\*/g, '$1');
    blocksBySection[row.section].push({
      name: row.block_name,
      section: row.section,
      body: rendered,
    });
  }

  // Resolve the logo path the same way quoteService does.
  let resolvedLogoPath = profile.logo_path || null;
  if (!resolvedLogoPath) {
    const branding = await db('app_settings').where('setting_key', 'branding_logo_url').first();
    if (branding?.setting_value) {
      try {
        const v = JSON.parse(branding.setting_value);
        if (typeof v === 'string') resolvedLogoPath = v;
      } catch (_) {
        resolvedLogoPath = branding.setting_value;
      }
    }
  }

  return {
    locale,
    dateFormat: locale === 'de' ? 'DD.MM.YYYY' : 'YYYY-MM-DD',
    issuer: profile ? {
      companyName: profile.company_name,
      addressLine1: profile.address_line1,
      addressLine2: profile.address_line2,
      postalCode: profile.postal_code,
      city: profile.city,
      country: profile.country_name || null,
      countryCodeIso: profile.country_code,
      phone: profile.phone,
      mobile: profile.mobile,
      email: profile.email,
      website: profile.website,
      vatId: profile.vat_id,
      logoPath: resolvedLogoPath,
      pdfFontTtfPath: profile.pdf_font_ttf_path,
      pdfFontFamily: profile.pdf_font_family || null,
      countryName: profile.country_name || null,
      showLogo: profile.pdf_show_logo == null ? true
        : (profile.pdf_show_logo === true || profile.pdf_show_logo === 1 || profile.pdf_show_logo === '1'),
      showCompanyName: profile.pdf_show_company_name == null ? true
        : (profile.pdf_show_company_name === true || profile.pdf_show_company_name === 1 || profile.pdf_show_company_name === '1'),
      logoHeight: profile.pdf_logo_height == null ? 56 : Number(profile.pdf_logo_height),
      companyNameInline: profile.pdf_company_name_inline === true || profile.pdf_company_name_inline === 1 || profile.pdf_company_name_inline === '1',
      foldingMarks: profile.pdf_folding_marks || 'none',
    } : {},
    recipient: (() => {
      const trimmedCompany = (customer?.company_name || '').trim();
      const personFull = [customer?.first_name, customer?.last_name]
        .map((s) => (s || '').trim()).filter(Boolean).join(' ');
      const header = trimmedCompany
        || personFull
        || (customer?.display_name || '').trim()
        || customer?.email
        || '';
      const attentionParts = [customer?.salutation, personFull].filter(Boolean);
      const attentionLine = attentionParts.length > 0 && trimmedCompany
        ? `z. Hd. ${attentionParts.join(' ')}`
        : '';
      return {
        issuerLine: profile?.company_name
          ? `${profile.company_name} * ${profile.address_line1 || ''} * ${profile.postal_code || ''} ${profile.city || ''}`
          : '',
        companyName: header,
        hasCompany: !!trimmedCompany,
        attentionLine,
        salutation: customer?.salutation || null,
        lastName: (customer?.last_name || '').trim() || null,
        addressLine1: customer?.address_line1,
        addressLine2: customer?.address_line2,
        postalCode: customer?.postal_code,
        city: customer?.city,
        country: customer?.country_name || null,
        countryCodeIso: customer?.country_code,
      };
    })(),
    doc: {
      contractNumber: contract.contract_number,
      title: contract.title || '',
      issueDate: contract.issue_date,
      validUntil: contract.valid_until,
      introText: contract.intro_text ? renderTemplatedBody(contract.intro_text, placeholders) : null,
      outroText: contract.outro_text ? renderTemplatedBody(contract.outro_text, placeholders) : null,
    },
    // Blocks grouped + ordered by canonical section order.
    sections: SECTIONS_ORDER
      .map((section) => ({ section, blocks: blocksBySection[section] }))
      .filter((s) => s.blocks.length > 0),
    // Signature evidence (used by the PDF renderer to stamp signatures
    // into the closing section when present).
    signatures: {
      customer: contract.signed_customer_name ? {
        name: contract.signed_customer_name,
        signedAt: contract.signed_by_customer_at,
        ip: contract.signed_customer_ip,
        signaturePath: contract.signed_customer_signature_path,
      } : null,
      admin: contract.signed_admin_name ? {
        name: contract.signed_admin_name,
        signedAt: contract.signed_by_admin_at,
        ip: contract.signed_admin_ip,
        signaturePath: contract.signed_admin_signature_path,
      } : null,
    },
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

async function listContracts({ filters = {}, sort = 'newest', page = 1, pageSize = 25 } = {}) {
  return await withRetry(async () => {
    let query = db('contracts')
      .leftJoin('customer_accounts', 'contracts.customer_account_id', 'customer_accounts.id')
      .select(
        'contracts.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
      );

    if (Array.isArray(filters.status) && filters.status.length > 0) {
      query = query.whereIn('contracts.status', filters.status);
    }
    if (filters.customerAccountId) {
      query = query.where('contracts.customer_account_id', filters.customerAccountId);
    }
    if (filters.q && String(filters.q).trim()) {
      const term = `%${String(filters.q).trim()}%`;
      query = query.andWhere(function() {
        this.where('contracts.contract_number', 'like', term)
          .orWhere('contracts.title', 'like', term)
          .orWhere('customer_accounts.email', 'like', term)
          .orWhere('customer_accounts.company_name', 'like', term);
      });
    }

    const countQuery = query.clone().clearSelect().clearOrder().count('contracts.id as total').first();
    const totalRow = await countQuery;
    const total = ensureInt(totalRow?.total || 0);

    switch (sort) {
      case 'oldest':
        query = query.orderBy('contracts.created_at', 'asc').orderBy('contracts.id', 'asc');
        break;
      case 'customer_asc':
        query = query
          .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) asc')
          .orderBy('contracts.id', 'desc');
        break;
      case 'newest':
      default:
        query = query.orderBy('contracts.created_at', 'desc').orderBy('contracts.id', 'desc');
        break;
    }

    const offset = Math.max(0, (page - 1) * pageSize);
    query = query.offset(offset).limit(pageSize);
    const rows = await query;
    return { rows, total, page, pageSize };
  });
}

async function getContractById(id) {
  return await withRetry(async () => {
    const contract = await db('contracts')
      .leftJoin('customer_accounts', 'contracts.customer_account_id', 'customer_accounts.id')
      .where('contracts.id', id)
      .select(
        'contracts.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
        'customer_accounts.preferred_language as customer_preferred_language',
      )
      .first();
    if (!contract) return null;

    const inclusions = await db('contract_block_inclusions as inc')
      .leftJoin('contract_blocks as blk', 'blk.id', 'inc.block_id')
      .where('inc.contract_id', id)
      .orderByRaw(`
        CASE inc.section
          WHEN 'basics' THEN 1
          WHEN 'scope' THEN 2
          WHEN 'privacy' THEN 3
          WHEN 'commercial' THEN 4
          WHEN 'nda' THEN 5
          WHEN 'closing' THEN 6
          ELSE 99
        END
      `)
      .orderBy('inc.position', 'asc')
      .select(
        'inc.*',
        'blk.slug as block_slug',
        'blk.name as block_name',
        'blk.description as block_description',
        'blk.body_text as block_body_text',
        'blk.body_text_de as block_body_text_de',
        'blk.is_system as block_is_system',
      );
    return { contract, inclusions };
  });
}

/**
 * Create a draft contract. Pre-populates `contract_block_inclusions`
 * with every active system block toggled ON so the admin sees a
 * sensible starting point and just toggles off what they don't need.
 *
 * Custom (non-system) blocks are NOT auto-included — admin opts in to
 * those explicitly so a runaway block library doesn't pollute every
 * new contract.
 */
async function createContract(payload, adminId) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  ensureCustomerActive(customer);

  const profile = (await businessProfileService.getProfile()).profile;
  const language = payload.language || customer.preferred_language || profile?.default_locale || 'de';
  const validDays = ensureInt(await getAppSetting('crm_contracts_default_valid_days')) || 30;
  const issueDate = payload.issueDate || new Date().toISOString().slice(0, 10);
  const validUntil = payload.validUntil || new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  return await db.transaction(async (trx) => {
    const contractNumber = await nextContractNumber();
    const row = {
      contract_number: contractNumber,
      customer_account_id: payload.customerAccountId,
      status: 'draft',
      language,
      issue_date: issueDate,
      valid_until: validUntil,
      title: payload.title || null,
      intro_text: payload.introText || null,
      outro_text: payload.outroText || null,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const inserted = await trx('contracts').insert(row).returning('id');
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Seed with every active system block, toggled on. Per-section
    // position = display_order from the source block.
    const systemBlocks = await trx('contract_blocks')
      .where({ is_system: true, is_active: true })
      .orderBy(['section', 'display_order']);
    const sectionCounters = {};
    for (const block of systemBlocks) {
      sectionCounters[block.section] = (sectionCounters[block.section] || 0) + 1;
      await trx('contract_block_inclusions').insert({
        contract_id: contractId,
        block_id: block.id,
        section: block.section,
        position: sectionCounters[block.section],
        body_text_snapshot: null,
        body_text_de_snapshot: null,
        included: true,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    try {
      await logActivity('contract_created', { contractId, contractNumber, customerAccountId: payload.customerAccountId }, null, `admin:${adminId}`);
    } catch (_) { /* logging is best-effort */ }

    logger.info('Contract created', { adminId, contractId, contractNumber });
    return contractId;
  });
}

/**
 * Update a draft contract. Editing a sent contract is refused — admin
 * must cancel + create a fresh one (avoids invalidating the customer's
 * signed copy).
 *
 * payload.blocks is an array of `{ blockId, included, position }`
 * tuples; the service rewrites the contract_block_inclusions rows
 * accordingly.
 */
async function updateContract(id, payload, adminId) {
  const existing = await db('contracts').where({ id }).first();
  if (!existing) throw new AppError('Contract not found', 404);
  if (existing.status !== 'draft') {
    throw new AppError(
      `Cannot edit a contract with status '${existing.status}'. Cancel and create a new contract for amendments.`,
      409,
      'CONTRACT_LOCKED',
    );
  }

  return await db.transaction(async (trx) => {
    const updates = { updated_at: new Date() };
    const map = {
      title: 'title',
      introText: 'intro_text',
      outroText: 'outro_text',
      language: 'language',
      validUntil: 'valid_until',
      issueDate: 'issue_date',
    };
    for (const [api, col] of Object.entries(map)) {
      if (api in payload) updates[col] = payload[api];
    }
    await trx('contracts').where({ id }).update(updates);

    // Replace inclusions only when the caller sent an explicit list.
    // (Editor's "save" sends every row; an inline "toggle" save could
    // send a partial update — current frontend always sends full list.)
    if (Array.isArray(payload.blocks)) {
      await trx('contract_block_inclusions').where({ contract_id: id }).del();
      // Recompute per-section position so we don't trust caller order
      // for ordering integrity; caller controls only the section
      // sequence via the order of items in payload.blocks.
      const sectionCounters = {};
      for (const entry of payload.blocks) {
        const block = await trx('contract_blocks').where({ id: entry.blockId }).first();
        if (!block) continue;
        sectionCounters[block.section] = (sectionCounters[block.section] || 0) + 1;
        await trx('contract_block_inclusions').insert({
          contract_id: id,
          block_id: block.id,
          section: block.section,
          position: ensureInt(entry.position) || sectionCounters[block.section],
          body_text_snapshot: null,
          body_text_de_snapshot: null,
          included: entry.included === false ? false : true,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    }

    try {
      await logActivity('contract_updated', { contractId: id }, null, `admin:${adminId}`);
    } catch (_) { /* logging is best-effort */ }
    return id;
  });
}

/**
 * Render PDF for a saved contract (preview before send, or re-render
 * after signing).
 */
async function renderContractPdfBuffer(contractId) {
  const data = await getContractById(contractId);
  if (!data) throw new AppError('Contract not found', 404);
  const ctx = await buildRenderContext(data.contract, data.inclusions);
  return await pdfService.renderContractToBuffer(ctx);
}

/**
 * Send the contract: snapshot every included block's body, render PDF,
 * persist, mint a signing token, queue the customer email.
 */
async function sendContract(id, adminId) {
  const data = await getContractById(id);
  if (!data) throw new AppError('Contract not found', 404);
  const { contract, inclusions } = data;

  if (!['draft'].includes(contract.status)) {
    throw new AppError(`Cannot send a contract with status '${contract.status}'`, 409);
  }

  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);

  // Snapshot every included block's body into the inclusion row so
  // future block edits don't mutate the sent contract.
  await db.transaction(async (trx) => {
    for (const inc of inclusions) {
      if (!(inc.included === true || inc.included === 1 || inc.included === '1')) continue;
      await trx('contract_block_inclusions').where({ id: inc.id }).update({
        body_text_snapshot: inc.block_body_text || null,
        body_text_de_snapshot: inc.block_body_text_de || null,
        updated_at: new Date(),
      });
    }
  });

  // Re-fetch with snapshots populated so the renderer uses the frozen
  // bodies (matches post-send reads).
  const refreshed = await getContractById(id);
  const ctx = await buildRenderContext(refreshed.contract, refreshed.inclusions);
  const buffer = await pdfService.renderContractToBuffer(ctx);
  const pdfPath = await persistContractPdf(refreshed.contract, buffer);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = contract.valid_until
    ? new Date(new Date(contract.valid_until).getTime() + 14 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  await db.transaction(async (trx) => {
    await trx('contract_action_tokens').insert({
      contract_id: id,
      token,
      expires_at: expiresAt,
      created_at: new Date(),
    });
    await trx('contracts').where({ id }).update({
      status: 'sent',
      sent_at: new Date(),
      pdf_path: pdfPath,
      updated_at: new Date(),
    });
  });

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  const responseUrl = `${frontendUrl}/contract/${token}`;
  await emailProcessor.queueEmail(null, customer.email, 'contract_sent', {
    contract_number: contract.contract_number,
    customer_name: customer.display_name
      || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
      || customer.email.split('@')[0],
    response_url: responseUrl,
    title: contract.title || '',
    event_name: contract.event_name || '',
    valid_until: formatShortDate(contract.valid_until),
    attachments: pdfPath ? [{
      filename: `${contract.contract_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }] : undefined,
  });

  try {
    await logActivity('contract_sent', { contractId: id, token }, null, `admin:${adminId}`);
  } catch (_) { /* logging is best-effort */ }

  logger.info('Contract sent', { adminId, contractId: id });
  return { token, pdfPath };
}

/**
 * Record a customer's in-browser signature (canvas + typed name +
 * "I accept" checkbox). Validates the token, persists the signature
 * PNG, re-renders the PDF with the signature stamped, flips status
 * to `signed_by_customer`, and queues the admin notification email.
 */
async function recordCustomerSignature({ token, name, ip, signatureDataUrl, accepted }) {
  if (accepted !== true) {
    throw new AppError('You must confirm that you have read and agree to the terms.', 400, 'TOS_REQUIRED');
  }
  if (!name || !String(name).trim()) {
    throw new AppError('Your name is required.', 400, 'NAME_REQUIRED');
  }
  const tokenRow = await db('contract_action_tokens').where({ token }).first();
  if (!tokenRow) throw new AppError('Token not found', 404);
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
    throw new AppError('This signing link has expired', 410);
  }
  if (tokenRow.used_at) {
    throw new AppError('This contract has already been signed', 410, 'TOKEN_ALREADY_USED');
  }

  const contract = await db('contracts').where({ id: tokenRow.contract_id }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['sent'].includes(contract.status)) {
    throw new AppError(`Contract cannot be signed in status '${contract.status}'`, 409);
  }

  const signaturePath = signatureDataUrl
    ? await persistSignatureImage(contract, 'customer', signatureDataUrl)
    : null;

  const now = new Date();
  await db.transaction(async (trx) => {
    await trx('contracts').where({ id: contract.id }).update({
      status: 'signed_by_customer',
      signed_by_customer_at: now,
      signed_customer_name: String(name).trim(),
      signed_customer_ip: ip || null,
      signed_customer_signature_path: signaturePath,
      updated_at: now,
    });
    await trx('contract_action_tokens').where({ id: tokenRow.id }).update({
      used_at: now,
      used_action: 'signed_by_customer',
      used_ip: ip || null,
    });
  });

  // Re-render the PDF with the signature stamped into the closing
  // block. Persist alongside the unsigned copy with a `_signed` suffix
  // so the original system PDF stays available for audit.
  const refreshed = await getContractById(contract.id);
  try {
    const ctx = await buildRenderContext(refreshed.contract, refreshed.inclusions);
    const signedBuffer = await pdfService.renderContractToBuffer(ctx);
    const signedPath = await persistContractPdf(refreshed.contract, signedBuffer, 'signed-by-customer');
    await db('contracts').where({ id: contract.id }).update({
      pdf_path: signedPath,
      updated_at: new Date(),
    });
  } catch (err) {
    // Signature recorded; PDF re-render is best-effort. The admin can
    // re-render manually from the detail page if this fails.
    logger.warn('Failed to re-render contract PDF after customer signature', {
      contractId: contract.id, error: err.message,
    });
  }

  // Notify admin.
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  try {
    await emailProcessor.queueEmail(null, null, 'contract_signed_admin_notification', {
      contract_number: contract.contract_number,
      customer_email: customer?.email || '',
      signed_customer_name: String(name).trim(),
      admin_dashboard_url: `${frontendUrl}/admin/clients/contracts/${contract.id}`,
    });
  } catch (err) {
    logger.warn('Failed to queue admin notification after customer signature', {
      contractId: contract.id, error: err.message,
    });
  }

  try {
    await logActivity('contract_signed_by_customer', { contractId: contract.id, token }, null, 'customer:public');
  } catch (_) { /* logging is best-effort */ }

  return { status: 'signed_by_customer', signedAt: now };
}

/**
 * Admin counter-signature. Bumps status to `fully_signed` (or
 * `signed_by_admin` if the customer hasn't signed yet — edge case
 * where admin signs first, e.g. issuer-side framework agreement).
 */
async function recordAdminCountersignature(contractId, { name, ip, signatureDataUrl }, adminId) {
  if (!name || !String(name).trim()) {
    throw new AppError('Your name is required.', 400, 'NAME_REQUIRED');
  }
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['signed_by_customer', 'sent'].includes(contract.status)) {
    throw new AppError(`Cannot counter-sign a contract with status '${contract.status}'`, 409);
  }

  const signaturePath = signatureDataUrl
    ? await persistSignatureImage(contract, 'admin', signatureDataUrl)
    : null;

  const now = new Date();
  const newStatus = contract.status === 'signed_by_customer' ? 'fully_signed' : 'signed_by_admin';
  await db('contracts').where({ id: contract.id }).update({
    status: newStatus,
    signed_by_admin_at: now,
    signed_admin_name: String(name).trim(),
    signed_admin_ip: ip || null,
    signed_admin_signature_path: signaturePath,
    updated_at: now,
  });

  // Re-render PDF with both signatures stamped.
  const refreshed = await getContractById(contract.id);
  try {
    const ctx = await buildRenderContext(refreshed.contract, refreshed.inclusions);
    const signedBuffer = await pdfService.renderContractToBuffer(ctx);
    const signedPath = await persistContractPdf(refreshed.contract, signedBuffer, newStatus === 'fully_signed' ? 'fully-signed' : 'signed-by-admin');
    await db('contracts').where({ id: contract.id }).update({
      pdf_path: signedPath,
      updated_at: new Date(),
    });
  } catch (err) {
    logger.warn('Failed to re-render contract PDF after admin signature', {
      contractId: contract.id, error: err.message,
    });
  }

  try {
    await logActivity(`contract_${newStatus}`, { contractId: contract.id }, null, `admin:${adminId}`);
  } catch (_) { /* logging is best-effort */ }

  return { status: newStatus, signedAt: now };
}

/**
 * Attach a wet-signed PDF as the authoritative signed copy. Either
 * party can upload (admin via admin route, customer via public token
 * route). When the customer uploads, status flips to `fully_signed`
 * because the wet signature is treated as a full agreement (admin
 * would normally also sign the wet copy before sending it to the
 * customer).
 */
async function attachSignedPdfUpload(contractId, filePath, uploaderRole) {
  if (!filePath) throw new AppError('No file uploaded', 400);
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (['cancelled', 'draft'].includes(contract.status)) {
    throw new AppError(`Cannot attach a signed PDF to a contract in status '${contract.status}'`, 409);
  }

  const now = new Date();
  const updates = {
    signed_pdf_path: filePath,
    status: 'fully_signed',
    updated_at: now,
  };
  if (uploaderRole === 'customer' && !contract.signed_by_customer_at) {
    updates.signed_by_customer_at = now;
  }
  if (uploaderRole === 'admin' && !contract.signed_by_admin_at) {
    updates.signed_by_admin_at = now;
  }
  await db('contracts').where({ id: contractId }).update(updates);

  try {
    await logActivity('contract_signed_pdf_uploaded', { contractId, uploaderRole }, null, uploaderRole === 'admin' ? 'admin:upload' : 'customer:public');
  } catch (_) { /* logging is best-effort */ }

  return { status: 'fully_signed', signedPdfPath: filePath };
}

/**
 * Convert an accepted quote into a fresh draft contract, pre-populating
 * the customer, language, title, valid-until window, and source_quote_id
 * back-pointer. Idempotent — if the quote already has a linked contract
 * (quote.converted_contract_id set), returns that contract's id without
 * creating a duplicate.
 *
 * Does NOT flip quote.status — the quote stays 'accepted' while the
 * contract is the active deliverable. The quote→event / quote→invoice
 * paths are gated against the converted_contract_id back-pointer so an
 * admin can't accidentally double-spend the quote.
 */
async function createFromQuote(quoteId, adminId) {
  const quote = await db('quotes').where({ id: quoteId }).first();
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'accepted') {
    throw new AppError(`Cannot convert a quote with status '${quote.status}'`, 409, 'QUOTE_NOT_ACCEPTED');
  }
  if (quote.converted_contract_id) {
    return { contractId: quote.converted_contract_id, alreadyConverted: true };
  }
  if (quote.converted_event_id) {
    throw new AppError(
      'This quote was already converted to an event. Create the contract from the event instead.',
      409, 'ALREADY_CONVERTED_TO_EVENT',
    );
  }

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerActive(customer);

  const profile = (await businessProfileService.getProfile()).profile;
  const validDays = ensureInt(await getAppSetting('crm_contracts_default_valid_days')) || 30;
  const issueDate = new Date().toISOString().slice(0, 10);
  const validUntil = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const title = quote.event_name
    ? `Contract — ${quote.event_name}`
    : `Contract from quote ${quote.quote_number}`;

  return await db.transaction(async (trx) => {
    const contractNumber = await nextContractNumber();
    const inserted = await trx('contracts').insert({
      contract_number: contractNumber,
      customer_account_id: quote.customer_account_id,
      status: 'draft',
      language: quote.language || customer.preferred_language || profile?.default_locale || 'de',
      issue_date: issueDate,
      valid_until: validUntil,
      title,
      intro_text: quote.intro_text || null,
      outro_text: quote.outro_text || null,
      source_quote_id: quote.id,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Seed every active system block. Same logic as createContract —
    // duplicated inline so this stays inside the transaction.
    const systemBlocks = await trx('contract_blocks')
      .where({ is_system: true, is_active: true })
      .orderBy(['section', 'display_order']);
    const sectionCounters = {};
    for (const block of systemBlocks) {
      sectionCounters[block.section] = (sectionCounters[block.section] || 0) + 1;
      await trx('contract_block_inclusions').insert({
        contract_id: contractId,
        block_id: block.id,
        section: block.section,
        position: sectionCounters[block.section],
        body_text_snapshot: null,
        body_text_de_snapshot: null,
        included: true,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    // Back-pointer so the quote detail page can deep-link to its
    // resulting contract and the convert-to-event/invoice paths know
    // to refuse double conversion.
    await trx('quotes').where({ id: quote.id }).update({
      converted_contract_id: contractId,
      updated_at: new Date(),
    });

    try {
      await logActivity('contract_created_from_quote',
        { contractId, contractNumber, quoteId: quote.id, quoteNumber: quote.quote_number },
        null, `admin:${adminId}`);
    } catch (_) { /* logging is best-effort */ }
    logger.info('Contract created from quote', { adminId, contractId, contractNumber, quoteId: quote.id });
    return { contractId, alreadyConverted: false };
  });
}

/**
 * Convert a fully-signed contract into an event + scheduled invoices.
 * Delegates to quoteService.convertToEvent using the contract's
 * source_quote_id so the line items + payment plan come from the
 * original quote. The quote MUST still be in 'accepted' status (i.e.
 * not previously converted) — createFromQuote keeps it that way.
 *
 * On success the contract's converted_event_id is set (back-pointer)
 * and the source quote flips to 'converted'.
 */
async function convertToEvent(contractId, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'fully_signed') {
    throw new AppError(
      `Cannot convert a contract with status '${contract.status}'. The contract must be fully signed by both parties first.`,
      409, 'CONTRACT_NOT_FULLY_SIGNED',
    );
  }
  if (contract.converted_event_id) {
    return { eventId: contract.converted_event_id, alreadyConverted: true };
  }
  if (!contract.source_quote_id) {
    throw new AppError(
      'This contract has no source quote and therefore no line items / payment plan to drive event creation. Create the event manually from the bills page.',
      409, 'NO_SOURCE_QUOTE',
    );
  }

  // Lazy require to break the contractService ↔ quoteService cycle.
  const quoteService = require('./quoteService');
  const result = await quoteService.convertToEvent(contract.source_quote_id, adminId, { fromContract: true });

  await db('contracts').where({ id: contractId }).update({
    converted_event_id: result.eventId,
    updated_at: new Date(),
  });
  try {
    await logActivity('contract_converted_to_event',
      { contractId, eventId: result.eventId, quoteId: contract.source_quote_id },
      result.eventId, `admin:${adminId}`);
  } catch (_) { /* logging is best-effort */ }
  return result;
}

/**
 * Convert a fully-signed contract directly into invoice(s) without
 * creating an event row. Same delegation pattern as convertToEvent.
 */
async function convertToInvoiceOnly(contractId, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'fully_signed') {
    throw new AppError(
      `Cannot convert a contract with status '${contract.status}'. The contract must be fully signed by both parties first.`,
      409, 'CONTRACT_NOT_FULLY_SIGNED',
    );
  }
  if (!contract.source_quote_id) {
    throw new AppError(
      'This contract has no source quote and therefore no line items / payment plan to drive invoice creation. Issue the invoice manually from the bills page.',
      409, 'NO_SOURCE_QUOTE',
    );
  }

  const quoteService = require('./quoteService');
  const result = await quoteService.convertToInvoiceOnly(contract.source_quote_id, adminId, { fromContract: true });

  // Tag the resulting invoices with the source contract id so the
  // contract detail page can list them as "resulting invoices".
  await db('invoices')
    .where({ source_quote_id: contract.source_quote_id })
    .whereNull('source_contract_id')
    .update({ source_contract_id: contractId });

  try {
    await logActivity('contract_converted_to_invoices',
      { contractId, quoteId: contract.source_quote_id, installments: result.installmentsCreated },
      null, `admin:${adminId}`);
  } catch (_) { /* logging is best-effort */ }
  return result;
}

async function cancelContract(id, adminId) {
  const contract = await db('contracts').where({ id }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['draft', 'sent'].includes(contract.status)) {
    throw new AppError(`Cannot cancel a contract with status '${contract.status}'`, 409);
  }
  await db('contracts').where({ id }).update({
    status: 'cancelled',
    updated_at: new Date(),
  });
  // Invalidate any outstanding tokens.
  await db('contract_action_tokens').where({ contract_id: id, used_at: null }).update({
    expires_at: new Date(),
  });
  try {
    await logActivity('contract_cancelled', { contractId: id }, null, `admin:${adminId}`);
  } catch (_) { /* logging is best-effort */ }
  return { status: 'cancelled' };
}

module.exports = {
  listContracts,
  getContractById,
  createContract,
  updateContract,
  sendContract,
  renderContractPdfBuffer,
  recordCustomerSignature,
  recordAdminCountersignature,
  attachSignedPdfUpload,
  cancelContract,
  createFromQuote,
  convertToEvent,
  convertToInvoiceOnly,
  // Exported for tests + the public-route preview endpoint.
  _internal: {
    nextContractNumber,
    renderTemplatedBody,
    buildPlaceholderContext,
    buildRenderContext,
    SECTIONS_ORDER,
  },
};

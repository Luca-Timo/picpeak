/**
 * Public → Contracts Routes
 *
 * Mounted at /api/public/contracts. NO authentication — the link in
 * the customer's signing email is the only secret.
 *
 * Surface:
 *   GET  /:token                  read-only contract view + included blocks
 *   POST /:token/sign             body: { name, signatureDataUrl?, accepted: true }
 *   POST /:token/upload-signed-pdf   multer single — customer uploads their wet-signed PDF
 *
 * No state mutation flows from /:token (GET) — only the two POST routes
 * affect the contract. IP is captured for the signature evidence /
 * upload audit row.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { body, param } = require('express-validator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { validateFileType } = require('../utils/fileSecurityUtils');
const contractService = require('../services/contractService');
const { getAppSetting } = require('../utils/appSettings');
const { db } = require('../database/db');

const router = express.Router();

const previewLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
});
const respondLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
});

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

const signedPdfStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(getStoragePath(), 'uploads/contracts/signed');
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `contract-token-${req.params.token.slice(0, 12)}-${Date.now()}${ext}`);
  },
});

const signedPdfUpload = multer({
  storage: signedPdfStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (validateFileType(file.originalname, file.mimetype, ['application/pdf'])) return cb(null, true);
    return cb(new Error('Only PDF files are allowed'));
  },
});

/**
 * Public-safe projection of the contract. We deliberately omit:
 *   - intro/outro text remain visible (customer-facing by design)
 *   - admin notes (none on contracts today)
 *   - admin IP + signature paths (signed_*_path is admin-only)
 *
 * The IP / signature image paths are NEVER exposed publicly even after
 * signing — they're audit evidence.
 */
function publicContractView(contract, inclusions, customer, profile, locale) {
  const orderedSections = ['basics', 'scope', 'privacy', 'commercial', 'nda', 'closing'];
  const blocksBySection = {};
  for (const s of orderedSections) blocksBySection[s] = [];
  for (const inc of inclusions) {
    if (!(inc.included === true || inc.included === 1 || inc.included === '1')) continue;
    const bodyEn = inc.body_text_snapshot || inc.block_body_text || '';
    const bodyDe = inc.body_text_de_snapshot || inc.block_body_text_de || '';
    // 1) Strip the leading `**Title**\n` line — the block.name is
    //    already rendered above as a bold sub-heading, so a bold
    //    first line in the body would duplicate it.
    // 2) Strip remaining `**bold**` inline markers — the React sign
    //    page renders body as plain `whitespace-pre-line` text and
    //    has no inline-bold UI. The PDF path keeps them as bold
    //    runs via pdfService.renderBodyMarkdown.
    const body = (locale === 'de' ? (bodyDe || bodyEn) : (bodyEn || bodyDe))
      .replace(/^\s*\*\*[^*\n]+\*\*\s*\n+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1');
    if (!blocksBySection[inc.section]) continue;
    blocksBySection[inc.section].push({
      blockId: inc.block_id,
      section: inc.section,
      position: inc.position,
      name: inc.block_name,
      body,
    });
  }
  const sections = orderedSections
    .map((s) => ({ section: s, blocks: blocksBySection[s] }))
    .filter((s) => s.blocks.length > 0);

  return {
    contractNumber: contract.contract_number,
    status: contract.status,
    language: contract.language,
    issueDate: contract.issue_date,
    validUntil: contract.valid_until,
    title: contract.title,
    introText: contract.intro_text,
    outroText: contract.outro_text,
    sentAt: contract.sent_at,
    signedByCustomerAt: contract.signed_by_customer_at,
    signedByAdminAt: contract.signed_by_admin_at,
    signedCustomerName: contract.signed_customer_name,
    signedAdminName: contract.signed_admin_name,
    // signed_pdf_path itself is admin-only; we just flag presence so
    // the public page can show a "wet-signed copy attached" hint.
    hasSignedPdf: !!contract.signed_pdf_path,
    canSign: contract.status === 'sent',
    sections,
    recipient: customer ? {
      displayName: customer.display_name || [customer.first_name, customer.last_name].filter(Boolean).join(' '),
      companyName: customer.company_name,
      email: customer.email,
    } : null,
    issuer: profile ? {
      companyName: profile.company_name,
      addressLine1: profile.address_line1,
      postalCode: profile.postal_code,
      city: profile.city,
      email: profile.email,
      website: profile.website,
    } : null,
  };
}

router.get(
  '/:token',
  previewLimiter,
  [param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await db('contract_action_tokens').where({ token: req.params.token }).first();
    if (!tokenRow) return res.status(404).json({ error: 'Contract not found' });
    if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'This link has expired' });
    }
    const data = await contractService.getContractById(tokenRow.contract_id);
    if (!data) return res.status(404).json({ error: 'Contract not found' });
    const customer = await db('customer_accounts').where({ id: data.contract.customer_account_id }).first();
    const profile = await db('business_profile').where({ id: 1 }).first();
    // Surface the admin-tunable behaviour toggles on the view so the
    // React page can hide the upload-PDF section when disabled and
    // enforce the drawn-signature requirement client-side. The server
    // re-enforces both, so client tampering only changes the UX.
    const allowPdfUpload = (await getAppSetting('crm_contracts_allow_pdf_upload')) !== false;
    const requireDrawnSignature = (await getAppSetting('crm_contracts_require_drawn_signature')) === true;
    const view = publicContractView(
      data.contract,
      data.inclusions,
      customer,
      profile,
      data.contract.language || 'de',
    );
    view.allowPdfUpload = allowPdfUpload;
    view.requireDrawnSignature = requireDrawnSignature;
    return successResponse(res, { contract: view });
  }),
);

router.post(
  '/:token/sign',
  respondLimiter,
  [
    param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
    body('name').isString().isLength({ min: 1, max: 255 }),
    body('accepted').isBoolean(),
    body('signatureDataUrl').optional({ nullable: true }).isString(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    try {
      const result = await contractService.recordCustomerSignature({
        token: req.params.token,
        name: req.body.name,
        signatureDataUrl: req.body.signatureDataUrl,
        accepted: req.body.accepted === true,
        ip,
      });
      return successResponse(res, result);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  }),
);

router.post(
  '/:token/upload-signed-pdf',
  respondLimiter,
  [param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i)],
  signedPdfUpload.single('file'),
  handleAsync(async (req, res) => {
    validateRequest(req);
    // Server-side guard for the "allow PDF upload" toggle. When the
    // admin turns it off in Settings → CRM behaviour → Contracts the
    // public sign page hides the upload section, but a hand-crafted
    // POST would still hit this route — refuse here too.
    const allowPdfUpload = (await getAppSetting('crm_contracts_allow_pdf_upload')) !== false;
    if (!allowPdfUpload) {
      return res.status(403).json({
        error: 'Uploading a wet-signed PDF is disabled for this installation. Please sign in your browser instead.',
        code: 'UPLOAD_DISABLED',
      });
    }
    const tokenRow = await db('contract_action_tokens').where({ token: req.params.token }).first();
    if (!tokenRow) return res.status(404).json({ error: 'Contract not found' });
    if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'This link has expired' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
    }
    const result = await contractService.attachSignedPdfUpload(
      tokenRow.contract_id,
      req.file.path,
      'customer',
    );
    // Mark the token as used so the link can't be re-played.
    await db('contract_action_tokens').where({ id: tokenRow.id }).update({
      used_at: new Date(),
      used_action: 'uploaded_signed_pdf',
      used_ip: req.ip || req.headers['x-forwarded-for'] || null,
    });
    return successResponse(res, result);
  }),
);

module.exports = router;

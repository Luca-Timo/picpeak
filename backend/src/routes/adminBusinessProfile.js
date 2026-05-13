/**
 * Admin → Business Profile Routes
 *
 * Endpoint mounted at /api/admin/business-profile (see server.js wiring).
 * Issuer block + bank-account roster that every quote/invoice PDF pulls
 * from. Gated by the existing `settings.edit` permission so any admin
 * who can edit Settings can edit this too — no separate CRM permission
 * required at this layer.
 *
 * Logo upload is delegated to the shared branding-upload helper at
 * /api/admin/branding/upload-logo and we just store the returned URL on
 * business_profile.logo_path; that route already has the multer +
 * resize stack we'd otherwise duplicate.
 */

const express = require('express');
const { body, param } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { getStoragePath } = require('../config/storage');
const businessProfileService = require('../services/businessProfileService');
const { db } = require('../database/db');

const router = express.Router();

// Multer config for the dedicated PDF letterhead logo. Same target
// directory as the global branding upload (storage/uploads/logos)
// but accepts SVG in addition to PNG / JPEG — the PDF renderer
// rasterises SVGs to PNG on the fly via resolveLogoFile() so the
// admin can drop a vector logo here and have it work in print.
const pdfLogoStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const dir = path.join(getStoragePath(), 'uploads/logos');
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `pdf-logo-${Date.now()}${ext}`);
  },
});

const pdfLogoUpload = multer({
  storage: pdfLogoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/svg+xml'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPEG and SVG logos are allowed'));
  },
});

/**
 * DB-shape → API shape. Keep narrow so adding new DB columns doesn't
 * silently leak through the API contract.
 */
function transformProfile(p) {
  if (!p) return null;
  return {
    id: p.id,
    companyName: p.company_name || '',
    addressLine1: p.address_line1 || '',
    addressLine2: p.address_line2 || '',
    postalCode: p.postal_code || '',
    city: p.city || '',
    state: p.state || '',
    countryCode: p.country_code || '',
    countryName: p.country_name || '',
    phone: p.phone || '',
    mobile: p.mobile || '',
    email: p.email || '',
    website: p.website || '',
    vatId: p.vat_id || '',
    vatLabel: p.vat_label || 'MwSt.',
    vatRateDefault: p.vat_rate_default == null ? null : Number(p.vat_rate_default),
    defaultCurrency: p.default_currency || 'CHF',
    defaultLocale: p.default_locale || 'de',
    defaultQrFormat: p.default_qr_format || 'none',
    footerLine: p.footer_line || '',
    logoPath: p.logo_path || '',
    pdfFontTtfPath: p.pdf_font_ttf_path || '',
    pdfShowLogo: p.pdf_show_logo == null ? true : (p.pdf_show_logo === true || p.pdf_show_logo === 1 || p.pdf_show_logo === '1'),
    pdfShowCompanyName: p.pdf_show_company_name == null ? true : (p.pdf_show_company_name === true || p.pdf_show_company_name === 1 || p.pdf_show_company_name === '1'),
    pdfFoldingMarks: p.pdf_folding_marks || 'none',
    pdfLogoHeight: p.pdf_logo_height == null ? 56 : Number(p.pdf_logo_height),
    pdfCompanyNameInline: p.pdf_company_name_inline === true || p.pdf_company_name_inline === 1 || p.pdf_company_name_inline === '1',
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function transformBank(b) {
  if (!b) return null;
  return {
    id: b.id,
    label: b.label || '',
    accountHolder: b.account_holder || '',
    iban: b.iban,
    bic: b.bic || '',
    currency: b.currency || '',
    isDefault: b.is_default === 1 || b.is_default === true || b.is_default === '1',
    displayOrder: b.display_order || 0,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

router.use(adminAuth);

// ---- GET / ------------------------------------------------------------
router.get(
  '/',
  requirePermission('settings.view'),
  handleAsync(async (req, res) => {
    const { profile, bankAccounts } = await businessProfileService.getProfile();
    return successResponse(res, {
      profile: transformProfile(profile),
      bankAccounts: bankAccounts.map(transformBank),
    });
  })
);

// ---- GET /logo-diagnostic ---------------------------------------------
// Diagnostic for "logo doesn't appear on PDF" tickets. Returns the
// configured logo sources (business_profile.logo_path,
// app_settings.branding_logo_path, app_settings.branding_logo_url),
// the storage root the renderer would use, the candidate paths the
// resolver would try, and which one (if any) currently resolves to
// an existing file. Read-only — never modifies anything.
router.get(
  '/logo-diagnostic',
  requirePermission('settings.view'),
  handleAsync(async (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const { getStoragePath } = require('../config/storage');
    const { getAppSetting } = require('../utils/appSettings');
    const { resolveLogoFile } = require('../utils/resolveLogoFile');

    const { profile } = await businessProfileService.getProfile();
    const storageRoot = getStoragePath();
    const brandingDiskPath = await getAppSetting('branding_logo_path');
    const brandingLogoUrl  = await getAppSetting('branding_logo_url');
    const resolved = await resolveLogoFile(profile);

    const inspect = (label, raw) => {
      const value = (raw || '').toString().trim();
      if (!value) return { label, value: null, candidates: [] };
      const stripped = value.replace(/^\/+/, '');
      const baseName = path.basename(value);
      const candidates = [
        path.isAbsolute(value) ? value : null,
        path.join(storageRoot, stripped),
        path.join(storageRoot, 'uploads', 'logos', baseName),
        path.join(storageRoot, 'branding', baseName),
        path.join(process.cwd(), 'storage', stripped),
        path.join(process.cwd(), 'storage', 'uploads', 'logos', baseName),
        path.join(process.cwd(), 'storage', 'branding', baseName),
      ].filter(Boolean);
      return {
        label, value,
        candidates: [...new Set(candidates)].map((p) => ({
          path: p,
          exists: (() => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } })(),
        })),
      };
    };

    return successResponse(res, {
      storageRoot,
      cwd: process.cwd(),
      resolvedTo: resolved,
      sources: [
        inspect('business_profile.logo_path', profile?.logo_path),
        inspect('app_settings.branding_logo_path', brandingDiskPath),
        inspect('app_settings.branding_logo_url',  brandingLogoUrl),
      ],
    });
  })
);

// ---- POST /logo, DELETE /logo -----------------------------------------
// Dedicated PDF letterhead logo upload (separate from the global
// Settings → Branding logo). PNG, JPEG, and SVG accepted; the PDF
// renderer rasterises SVG to PNG via resolveLogoFile() so vector
// uploads work in print. The relative path is stored in
// business_profile.logo_path; the existing fallback to
// branding_logo_path still applies when this is unset.
router.post(
  '/logo',
  requirePermission('settings.edit'),
  pdfLogoUpload.single('logo'),
  handleAsync(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No logo file uploaded' });
    }

    // Clean up the previous PDF logo on disk if it was uploaded via
    // this same endpoint (matches the pdf-logo-* prefix). We leave
    // anything else untouched — the admin may have set logo_path to
    // a path managed by a different system.
    try {
      const previous = await db('business_profile').where({ id: 1 }).first();
      const prev = previous?.logo_path;
      if (prev && typeof prev === 'string' && /pdf-logo-\d+\./.test(prev)) {
        const stripped = prev.replace(/^\/+/, '');
        const prevDisk = path.isAbsolute(prev)
          ? prev
          : path.join(getStoragePath(), stripped);
        try { await fs.unlink(prevDisk); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }

    const relative = `/uploads/logos/${req.file.filename}`;
    await businessProfileService.updateProfile(
      { logo_path: relative },
      req.admin.id
    );

    return successResponse(res, { logoPath: relative }, 200, 'PDF logo uploaded');
  })
);

router.delete(
  '/logo',
  requirePermission('settings.edit'),
  handleAsync(async (req, res) => {
    const existing = await db('business_profile').where({ id: 1 }).first();
    const prev = existing?.logo_path;
    if (prev && typeof prev === 'string' && /pdf-logo-\d+\./.test(prev)) {
      const stripped = prev.replace(/^\/+/, '');
      const prevDisk = path.isAbsolute(prev)
        ? prev
        : path.join(getStoragePath(), stripped);
      try { await fs.unlink(prevDisk); } catch (_) { /* ignore */ }
    }
    await businessProfileService.updateProfile(
      { logo_path: '' },
      req.admin.id
    );
    return successResponse(res, { cleared: true }, 200, 'PDF logo cleared');
  })
);

// ---- PUT / ------------------------------------------------------------
router.put(
  '/',
  requirePermission('settings.edit'),
  [
    // All fields optional — partial update is fine. We only run shallow
    // shape validation on the types that absolutely must be sane;
    // service layer does the trimming + currency/country normalisation.
    body('companyName').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('addressLine1').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('addressLine2').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('postalCode').optional({ values: 'falsy' }).isString().isLength({ max: 20 }),
    body('city').optional({ values: 'falsy' }).isString().isLength({ max: 120 }),
    body('state').optional({ values: 'falsy' }).isString().isLength({ max: 120 }),
    body('countryCode').optional({ values: 'falsy' }).isString().isLength({ min: 2, max: 2 }),
    body('countryName').optional({ values: 'falsy' }).isString().isLength({ max: 120 }),
    body('phone').optional({ values: 'falsy' }).isString().isLength({ max: 64 }),
    body('mobile').optional({ values: 'falsy' }).isString().isLength({ max: 64 }),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Invalid issuer email'),
    body('website').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('vatId').optional({ values: 'falsy' }).isString().isLength({ max: 64 }),
    body('vatLabel').optional({ values: 'falsy' }).isString().isLength({ max: 64 }),
    body('vatRateDefault').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
    body('defaultCurrency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
    body('defaultLocale').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
    body('defaultQrFormat').optional({ values: 'falsy' }).isIn(['swiss', 'epc', 'none']),
    body('footerLine').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('logoPath').optional({ values: 'falsy' }).isString().isLength({ max: 512 }),
    body('pdfFontTtfPath').optional({ values: 'falsy' }).isString().isLength({ max: 512 }),
    // Visibility toggles use the explicit-undefined check pattern so
    // `false` actually reaches the service layer. `optional({ values:
    // 'falsy' })` would drop `false` and the toggle could never be
    // disabled.
    body('pdfShowLogo').optional().isBoolean(),
    body('pdfShowCompanyName').optional().isBoolean(),
    body('pdfCompanyNameInline').optional().isBoolean(),
    body('pdfFoldingMarks').optional({ values: 'falsy' }).isIn(['none', 'half', 'third', 'both']),
    body('pdfLogoHeight').optional({ values: 'falsy' }).isInt({ min: 24, max: 200 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    // Convert camelCase → snake_case for the service layer.
    const payload = {};
    const map = {
      companyName: 'company_name',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      postalCode: 'postal_code',
      city: 'city',
      state: 'state',
      countryCode: 'country_code',
      countryName: 'country_name',
      phone: 'phone',
      mobile: 'mobile',
      email: 'email',
      website: 'website',
      vatId: 'vat_id',
      vatLabel: 'vat_label',
      vatRateDefault: 'vat_rate_default',
      defaultCurrency: 'default_currency',
      defaultLocale: 'default_locale',
      defaultQrFormat: 'default_qr_format',
      footerLine: 'footer_line',
      logoPath: 'logo_path',
      pdfFontTtfPath: 'pdf_font_ttf_path',
      pdfShowLogo: 'pdf_show_logo',
      pdfShowCompanyName: 'pdf_show_company_name',
      pdfCompanyNameInline: 'pdf_company_name_inline',
      pdfFoldingMarks: 'pdf_folding_marks',
      pdfLogoHeight: 'pdf_logo_height',
    };
    for (const [api, db] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(req.body, api)) {
        payload[db] = req.body[api];
      }
    }

    const { profile, bankAccounts } = await businessProfileService.updateProfile(
      payload,
      req.admin.id
    );
    return successResponse(res, {
      profile: transformProfile(profile),
      bankAccounts: bankAccounts.map(transformBank),
    }, 200, 'Business profile updated');
  })
);

// ---- bank accounts ----------------------------------------------------
router.get(
  '/bank-accounts',
  requirePermission('settings.view'),
  handleAsync(async (req, res) => {
    const { bankAccounts } = await businessProfileService.getProfile();
    return successResponse(res, { bankAccounts: bankAccounts.map(transformBank) });
  })
);

router.post(
  '/bank-accounts',
  requirePermission('settings.edit'),
  [
    body('iban').isString().isLength({ min: 5, max: 64 }).withMessage('IBAN is required'),
    body('label').optional({ values: 'falsy' }).isString().isLength({ max: 128 }),
    body('accountHolder').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('bic').optional({ values: 'falsy' }).isString().isLength({ max: 16 }),
    body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
    body('isDefault').optional({ values: 'falsy' }).isBoolean(),
    body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const bank = await businessProfileService.createBankAccount({
      iban: req.body.iban,
      label: req.body.label,
      account_holder: req.body.accountHolder,
      bic: req.body.bic,
      currency: req.body.currency,
      is_default: req.body.isDefault,
      display_order: req.body.displayOrder,
    }, req.admin.id);
    return successResponse(res, { bankAccount: transformBank(bank) }, 201, 'Bank account created');
  })
);

router.put(
  '/bank-accounts/:id',
  requirePermission('settings.edit'),
  [
    param('id').isInt({ min: 1 }),
    body('iban').optional({ values: 'falsy' }).isString().isLength({ min: 5, max: 64 }),
    body('label').optional({ values: 'falsy' }).isString().isLength({ max: 128 }),
    body('accountHolder').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('bic').optional({ values: 'falsy' }).isString().isLength({ max: 16 }),
    body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
    body('isDefault').optional({ values: 'falsy' }).isBoolean(),
    body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const payload = {};
    const map = {
      iban: 'iban',
      label: 'label',
      accountHolder: 'account_holder',
      bic: 'bic',
      currency: 'currency',
      isDefault: 'is_default',
      displayOrder: 'display_order',
    };
    for (const [api, db] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(req.body, api)) {
        payload[db] = req.body[api];
      }
    }
    const bank = await businessProfileService.updateBankAccount(id, payload, req.admin.id);
    return successResponse(res, { bankAccount: transformBank(bank) }, 200, 'Bank account updated');
  })
);

router.delete(
  '/bank-accounts/:id',
  requirePermission('settings.edit'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    await businessProfileService.deleteBankAccount(id, req.admin.id);
    return successResponse(res, { deleted: true }, 200, 'Bank account deleted');
  })
);

module.exports = router;

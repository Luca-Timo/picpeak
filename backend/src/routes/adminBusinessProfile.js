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
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const businessProfileService = require('../services/businessProfileService');

const router = express.Router();

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

// ---- PUT / ------------------------------------------------------------
router.put(
  '/',
  requirePermission('settings.edit'),
  [
    // All fields optional — partial update is fine. We only run shallow
    // shape validation on the types that absolutely must be sane;
    // service layer does the trimming + currency/country normalisation.
    body('companyName').optional().isString().isLength({ max: 255 }),
    body('addressLine1').optional().isString().isLength({ max: 255 }),
    body('addressLine2').optional().isString().isLength({ max: 255 }),
    body('postalCode').optional().isString().isLength({ max: 20 }),
    body('city').optional().isString().isLength({ max: 120 }),
    body('state').optional().isString().isLength({ max: 120 }),
    body('countryCode').optional().isString().isLength({ min: 2, max: 2 }),
    body('phone').optional().isString().isLength({ max: 64 }),
    body('mobile').optional().isString().isLength({ max: 64 }),
    body('email').optional().isEmail().withMessage('Invalid issuer email'),
    body('website').optional().isString().isLength({ max: 255 }),
    body('vatId').optional().isString().isLength({ max: 64 }),
    body('vatLabel').optional().isString().isLength({ max: 64 }),
    body('vatRateDefault').optional().isFloat({ min: 0, max: 100 }),
    body('defaultCurrency').optional().isString().isLength({ min: 3, max: 3 }),
    body('defaultLocale').optional().isString().isLength({ max: 8 }),
    body('defaultQrFormat').optional().isIn(['swiss', 'epc', 'none']),
    body('footerLine').optional().isString().isLength({ max: 255 }),
    body('logoPath').optional().isString().isLength({ max: 512 }),
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
    };
    for (const [api, db] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(req.body, api)) {
        payload[db] = req.body[api];
      }
    }

    const { profile, bankAccounts } = await businessProfileService.updateProfile(
      payload,
      req.user.id
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
    body('label').optional().isString().isLength({ max: 128 }),
    body('accountHolder').optional().isString().isLength({ max: 255 }),
    body('bic').optional().isString().isLength({ max: 16 }),
    body('currency').optional().isString().isLength({ min: 3, max: 3 }),
    body('isDefault').optional().isBoolean(),
    body('displayOrder').optional().isInt({ min: 0, max: 9999 }),
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
    }, req.user.id);
    return successResponse(res, { bankAccount: transformBank(bank) }, 201, 'Bank account created');
  })
);

router.put(
  '/bank-accounts/:id',
  requirePermission('settings.edit'),
  [
    param('id').isInt({ min: 1 }),
    body('iban').optional().isString().isLength({ min: 5, max: 64 }),
    body('label').optional().isString().isLength({ max: 128 }),
    body('accountHolder').optional().isString().isLength({ max: 255 }),
    body('bic').optional().isString().isLength({ max: 16 }),
    body('currency').optional().isString().isLength({ min: 3, max: 3 }),
    body('isDefault').optional().isBoolean(),
    body('displayOrder').optional().isInt({ min: 0, max: 9999 }),
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
    const bank = await businessProfileService.updateBankAccount(id, payload, req.user.id);
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
    await businessProfileService.deleteBankAccount(id, req.user.id);
    return successResponse(res, { deleted: true }, 200, 'Bank account deleted');
  })
);

module.exports = router;

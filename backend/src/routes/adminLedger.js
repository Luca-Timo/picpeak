/**
 * Admin → Ledger (Accounting Layer A) routes. Mounted at /api/admin/ledger.
 *
 *   /accounts    CRUD   chart of accounts (Swiss/LI KMU-Kontenrahmen)
 *   /vat-codes   CRUD   MWST codes
 *   /mappings    GET/PATCH   category→account + default-account/VAT settings
 *   /export      GET    Treuhänder collective-journal CSV (generic|banana|bexio)
 *
 * Gated by the `accounting` master flag (all routes, incl. /export). Uses the
 * `accounting.*` permissions. Output is a GUIDELINE — the UI carries the
 * Treuhänder caveat.
 */
const express = require('express');
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { db } = require('../database/db');
const ledgerService = require('../services/ledgerService');

const router = express.Router();
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : undefined; };

function requireFlag(key, code) {
  return async (req, res, next) => {
    try {
      const row = await db('feature_flags').where({ key }).first();
      const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
      if (!enabled) return res.status(403).json({ error: `${key} feature is disabled`, code });
      return next();
    } catch (err) { return next(err); }
  };
}
const requireAccounting = requireFlag('accounting', 'ACCOUNTING_DISABLED');

router.use(adminAuth);
router.use(requireAccounting);

// ── chart of accounts ────────────────────────────────────────────────
router.get('/accounts', requirePermission('accounting.view'), handleAsync(async (_req, res) =>
  successResponse(res, { items: await ledgerService.listAccounts() })));

router.post('/accounts', requirePermission('accounting.manage'),
  [body('number').isString().isLength({ min: 1, max: 16 }), body('name').isString().isLength({ min: 1, max: 200 }),
    body('type').isIn(ledgerService.ACCOUNT_TYPES)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { account: await ledgerService.createAccount(req.body) }, 201, 'Account created');
  }));

router.patch('/accounts/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('type').optional().isIn(ledgerService.ACCOUNT_TYPES)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { account: await ledgerService.updateAccount(toInt(req.params.id), req.body) });
  }));

router.delete('/accounts/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await ledgerService.deleteAccount(toInt(req.params.id)));
  }));

// ── VAT codes ────────────────────────────────────────────────────────
router.get('/vat-codes', requirePermission('accounting.view'), handleAsync(async (_req, res) =>
  successResponse(res, { items: await ledgerService.listVatCodes() })));

router.post('/vat-codes', requirePermission('accounting.manage'),
  [body('code').isString().isLength({ min: 1, max: 16 }), body('name').isString().isLength({ min: 1, max: 200 }),
    body('rate').optional().isFloat({ min: 0 }), body('direction').isIn(ledgerService.VAT_DIRECTIONS),
    body('accountId').optional({ nullable: true }).isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { vatCode: await ledgerService.createVatCode(req.body) }, 201, 'VAT code created');
  }));

router.patch('/vat-codes/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('direction').optional().isIn(ledgerService.VAT_DIRECTIONS),
    body('rate').optional().isFloat({ min: 0 }), body('accountId').optional({ nullable: true }).isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { vatCode: await ledgerService.updateVatCode(toInt(req.params.id), req.body) });
  }));

router.delete('/vat-codes/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await ledgerService.deleteVatCode(toInt(req.params.id)));
  }));

// ── mappings (category→account + default accounts / VAT maps) ─────────
router.get('/mappings', requirePermission('accounting.view'), handleAsync(async (_req, res) =>
  successResponse(res, await ledgerService.getMappings())));

router.patch('/mappings/category/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('ledgerAccountId').optional({ nullable: true }).isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { category: await ledgerService.setCategoryAccount(toInt(req.params.id), req.body.ledgerAccountId ?? null) });
  }));

router.patch('/mappings/settings', requirePermission('accounting.manage'), handleAsync(async (req, res) => {
  return successResponse(res, await ledgerService.updateSettings(req.body || {}));
}));

// ── Treuhänder export ────────────────────────────────────────────────
// Gated by the router-level `accounting` flag only — the export lives on the
// Tax page now but is an accounting-layer feature (needs the chart-of-accounts
// mapping), so it no longer requires the `taxReport` sub-flag.
router.get('/export', requirePermission('bills.view'),
  [query('from').matches(/^\d{4}-\d{2}-\d{2}$/), query('to').matches(/^\d{4}-\d{2}-\d{2}$/),
    query('currency').matches(/^[A-Za-z]{3}$/), query('format').optional().isIn(ledgerService.EXPORT_FORMATS)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const { content, filename, contentType } = await ledgerService.exportPostings({
      from: req.query.from, to: req.query.to,
      currency: String(req.query.currency).toUpperCase(),
      format: req.query.format || 'generic',
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(content);
  }));

module.exports = router;

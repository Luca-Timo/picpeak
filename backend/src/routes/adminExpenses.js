/**
 * Admin Accounting routes — inbound supplier invoices + expenses + re-bill.
 *
 * Gated by the `accounting` feature flag and `accounting.view` /
 * `accounting.manage` permissions. camelCase API ↔ camelCase service payloads
 * (the service maps to snake_case columns). Money is integer minor units.
 */
const express = require('express');
const { body, param, query } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { getStoragePath } = require('../config/storage');
const { db } = require('../database/db');
const expenseService = require('../services/expenseService');
const expenseCategoriesService = require('../services/expenseCategoriesService');

const router = express.Router();

// Inbound documents accept PDFs AND images (phone/tablet camera capture).
const inboundStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const year = new Date().getFullYear();
    const dir = path.join(getStoragePath(), 'business-docs', 'inbound', String(year));
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `inbound-${Date.now()}${ext}`);
  },
});
const INBOUND_MIME = ['application/pdf', 'image/jpeg', 'image/png'];
const inboundUpload = multer({
  storage: inboundStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB — camera photos run large
  fileFilter: (_req, file, cb) => {
    if (INBOUND_MIME.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Only PDF, JPEG or PNG files are allowed'));
  },
});

// Gated on the `incomingInvoices` sub-feature, which the feature-flag
// dependency rules force OFF whenever the `accounting` master is off — so
// this single check covers both.
async function requireIncomingInvoicesFlag(req, res, next) {
  try {
    const row = await db('feature_flags').where({ key: 'incomingInvoices' }).first();
    const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
    if (!enabled) return res.status(403).json({ error: 'Incoming invoices feature is disabled', code: 'INCOMING_INVOICES_DISABLED' });
    return next();
  } catch (err) { return next(err); }
}

router.use(adminAuth);
router.use(requireIncomingInvoicesFlag);

// ── Expense categories (literal path — register BEFORE '/:id') ──────────────
router.get('/categories', requirePermission('accounting.view'), handleAsync(async (_req, res) => {
  return successResponse(res, { items: await expenseCategoriesService.list() });
}));

router.post('/categories', requirePermission('accounting.manage'),
  [body('name').isString().isLength({ min: 1, max: 128 }), body('color').optional({ nullable: true }).isString()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const cat = await expenseCategoriesService.create(req.body, req.admin.id);
    return successResponse(res, { category: cat }, 201, 'Category created');
  }));

router.patch('/categories/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const cat = await expenseCategoriesService.update(parseInt(req.params.id, 10), req.body);
    return successResponse(res, { category: cat });
  }));

router.delete('/categories/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await expenseCategoriesService.remove(parseInt(req.params.id, 10)));
  }));

// ── Inbound documents (literal path — register BEFORE '/:id') ───────────────
router.post('/inbound', requirePermission('accounting.manage'),
  inboundUpload.single('file'),
  [body('source').optional().isIn(['upload', 'camera', 'email', 'manual'])],
  handleAsync(async (req, res) => {
    validateRequest(req);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
    const doc = await expenseService.recordInboundDocument({
      source: req.body.source || 'upload',
      filePath: req.file.path,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
    }, req.admin.id);
    return successResponse(res, { document: doc }, 201, 'Document captured');
  }));

router.get('/inbound', requirePermission('accounting.view'),
  [query('status').optional().isString(), query('page').optional().isInt({ min: 1 }), query('pageSize').optional().isInt({ min: 1, max: 100 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await expenseService.listInbound(req.query));
  }));

router.get('/inbound/:id', requirePermission('accounting.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { document: await expenseService.getInbound(parseInt(req.params.id, 10)) });
  }));

router.patch('/inbound/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const doc = await expenseService.updateInbound(parseInt(req.params.id, 10), req.body, req.admin.id);
    return successResponse(res, { document: doc });
  }));

router.post('/inbound/:id/categorize', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('disposition').isIn(expenseService.DISPOSITIONS)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const expense = await expenseService.categorizeInbound(parseInt(req.params.id, 10), req.body, req.admin.id);
    return successResponse(res, { expense }, 201, 'Expense created');
  }));

// ── Expenses ────────────────────────────────────────────────────────────────
router.get('/', requirePermission('accounting.view'),
  [query('status').optional().isString(), query('disposition').optional().isIn(expenseService.DISPOSITIONS),
    query('customerAccountId').optional().isInt({ min: 1 }), query('eventId').optional().isInt({ min: 1 }),
    query('page').optional().isInt({ min: 1 }), query('pageSize').optional().isInt({ min: 1, max: 100 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await expenseService.listExpenses(req.query));
  }));

router.post('/', requirePermission('accounting.manage'),
  [body('disposition').isIn(expenseService.DISPOSITIONS)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const expense = await expenseService.createManualExpense(req.body, req.admin.id);
    return successResponse(res, { expense }, 201, 'Expense created');
  }));

router.get('/:id', requirePermission('accounting.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { expense: await expenseService.getExpense(parseInt(req.params.id, 10)) });
  }));

router.patch('/:id', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const expense = await expenseService.updateExpense(parseInt(req.params.id, 10), req.body, req.admin.id);
    return successResponse(res, { expense });
  }));

router.post('/:id/rebill', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('customerAccountId').isInt({ min: 1 }),
    body('eventId').optional({ nullable: true }).isInt({ min: 1 }),
    body('contractId').optional({ nullable: true }).isInt({ min: 1 }),
    body('markupType').optional().isIn(expenseService.MARKUP_TYPES)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await expenseService.rebillToEvent(parseInt(req.params.id, 10), req.body, req.admin.id);
    return successResponse(res, result, 201, 'Expense re-billed');
  }));

router.post('/:id/supplier-payment', requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('paid').isBoolean(),
    body('paymentMethod').optional({ nullable: true }).isIn(expenseService.PAYMENT_METHODS)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const expense = await expenseService.setSupplierPayment(parseInt(req.params.id, 10), req.body, req.admin.id);
    return successResponse(res, { expense });
  }));

module.exports = router;

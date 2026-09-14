/**
 * Read-only VAT-code registry for the invoice / quote editors.
 *
 * Mounted at /api/admin/vat-codes. UN-gated by the `accounting` flag on purpose:
 * invoices need their preset VAT codes even when the accounting layer is off, so
 * the editor must be able to read the list regardless. Any authenticated admin
 * may read the (innocuous) tax-code list. MANAGEMENT (create/update/delete) stays
 * in the accounting-gated /api/admin/ledger routes — this is read-only.
 *
 *   GET /  [?direction=output|input]  → { items: [{ id, code, name, rate, direction }] }
 */
const express = require('express');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, successResponse } = require('../utils/routeHelpers');
const ledgerService = require('../services/ledgerService');

const router = express.Router();

// Migration 174: the VAT-code list is reference data the invoice/quote editors
// read, so it must stay readable by anyone who can touch those documents. We
// gate it with a broad OR (its own vat_codes.view plus every CRM-editor perm)
// rather than a single narrow perm — completeness without breaking any editor.
const VAT_CODE_READERS = [
  'vat_codes.view',
  'bills.view', 'bills.manage',
  'quotes.view', 'quotes.manage',
  'contracts.view', 'contracts.manage',
  'accounting.view', 'accounting.manage',
];

router.get('/', adminAuth, requirePermission(VAT_CODE_READERS), handleAsync(async (req, res) => {
  const items = await ledgerService.listVatCodes();
  const active = items.filter((v) => v.active !== false);
  const { direction } = req.query;
  const filtered = (direction === 'output' || direction === 'input')
    ? active.filter((v) => v.direction === direction)
    : active;
  return successResponse(res, {
    items: filtered.map((v) => ({
      id: v.id, code: v.code, name: v.name, rate: Number(v.rate) || 0, direction: v.direction,
    })),
  });
}));

module.exports = router;

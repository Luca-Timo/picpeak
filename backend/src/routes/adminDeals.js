/**
 * Admin → deals lineage endpoint.
 *
 * One UUID per customer engagement spans every quote, contract, and
 * invoice (migration 140). This route exposes the union: given a
 * deal_uuid, return every related document so the frontend's
 * DocumentLineageCard can render the full chain with a single query
 * instead of walking the legacy point-to-point FKs in JS.
 *
 * Read-only. The same `customers.view` permission used elsewhere for
 * lineage display is the gate here — anyone who can read a quote or
 * invoice detail page can read its deal lineage.
 *
 * Sibling routes (`/api/admin/quotes/:id/lineage`,
 * `/api/admin/contracts/:id/lineage`, `/api/admin/invoices/:id/lineage`)
 * also exist as conveniences so the frontend doesn't have to fetch
 * the deal_uuid first; they resolve and delegate to the same service.
 */

const express = require('express');
const { param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const dealsService = require('../services/dealsService');

const router = express.Router();
router.use(adminAuth);

router.get(
  '/:uuid/documents',
  requirePermission('customers.view'),
  // UUID v4 format check — adminCalendar uses a similar pattern.
  // Length window 32–36 covers both hyphenated and non-hyphenated
  // forms; the service does the actual lookup.
  [param('uuid').isString().isLength({ min: 32, max: 36 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await dealsService.getDealDocuments(req.params.uuid);
    return successResponse(res, result);
  }),
);

module.exports = router;

/**
 * Admin → Transfers routes (PicTransfer, #997).
 *
 * Mounted at /api/admin/transfers. A transfer bundles ORIGINAL photos picked
 * from any event into a token-protected download link, and can optionally open
 * a short upload token so the client can send files back.
 *
 * Read  = `events.view`; write = `events.edit` (transfers are an
 * events/photos-adjacent admin tool, so they ride the same permissions as the
 * projects cockpit rather than inventing a new permission).
 */

const express = require('express');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const transferService = require('../services/transferService');
const fs = require('fs');

const router = express.Router();

router.use(adminAuth);
// PicTransfer is a strictly opt-in module — refuse every admin transfer route
// when the `transfers` feature flag is off, so a disabled feature is never
// actable even by a direct API hit (the sidebar already hides the surface).
router.use(requireFeatureFlag('transfers'));

// List
router.get('/', requirePermission('events.view'), handleAsync(async (req, res) => {
  const transfers = await transferService.listTransfers({ search: req.query.q || '' });
  return successResponse(res, { transfers });
}));

// Create
router.post('/',
  requirePermission('events.edit'),
  [
    body('title').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('message').optional({ nullable: true }).isString().isLength({ max: 5000 }),
    body('expiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 3650 }),
    body('maxDownloads').optional({ nullable: true }).isInt({ min: 0, max: 1000000 }),
    body('graceDays').optional({ nullable: true }).isInt({ min: 0, max: 365 }),
    body('allowUploads').optional().isBoolean(),
    body('uploadExpiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 3650 }),
    body('photoIds').optional().isArray({ max: 5000 }),
    body('photoIds.*').optional().isInt({ min: 1 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.createTransfer({
      title: req.body.title,
      message: req.body.message,
      expiresInDays: req.body.expiresInDays,
      maxDownloads: req.body.maxDownloads,
      graceDays: req.body.graceDays,
      allowUploads: req.body.allowUploads === true,
      uploadExpiresInDays: req.body.uploadExpiresInDays,
      photoIds: req.body.photoIds || [],
    }, req.admin.id);
    return successResponse(res, { transfer }, 201, 'Transfer created');
  }),
);

// Detail
router.get('/:id',
  requirePermission('events.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.getTransfer(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer });
  }),
);

// Update
router.patch('/:id',
  requirePermission('events.edit'),
  [
    param('id').isInt({ min: 1 }),
    body('title').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('message').optional({ nullable: true }).isString().isLength({ max: 5000 }),
    body('maxDownloads').optional({ nullable: true }).isInt({ min: 0, max: 1000000 }),
    body('graceDays').optional({ nullable: true }).isInt({ min: 0, max: 365 }),
    body('expiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 3650 }),
    body('expiresAt').optional({ nullable: true }).isISO8601(),
    body('isActive').optional().isBoolean(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.updateTransfer(parseInt(req.params.id, 10), {
      title: req.body.title,
      message: req.body.message,
      maxDownloads: req.body.maxDownloads,
      graceDays: req.body.graceDays,
      expiresInDays: req.body.expiresInDays,
      expiresAt: req.body.expiresAt,
      isActive: req.body.isActive,
    });
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'Transfer updated');
  }),
);

// Delete
router.delete('/:id',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const ok = await transferService.deleteTransfer(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { deleted: true }, 200, 'Transfer deleted');
  }),
);

// Add photos (cross-event) to a transfer
router.post('/:id/files',
  requirePermission('events.edit'),
  [
    param('id').isInt({ min: 1 }),
    body('photoIds').isArray({ min: 1, max: 5000 }),
    body('photoIds.*').isInt({ min: 1 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const existing = await transferService.getTransfer(parseInt(req.params.id, 10));
    if (!existing) return res.status(404).json({ error: 'Transfer not found' });
    const transfer = await transferService.addFiles(parseInt(req.params.id, 10), req.body.photoIds);
    return successResponse(res, { transfer }, 200, 'Files added');
  }),
);

// Remove one file from a transfer
router.delete('/:id/files/:fileId',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), param('fileId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.removeFile(
      parseInt(req.params.id, 10), parseInt(req.params.fileId, 10),
    );
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'File removed');
  }),
);

// Enable / regenerate the client-upload link
router.post('/:id/upload-link',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), body('uploadExpiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 3650 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.enableUploads(
      parseInt(req.params.id, 10), { uploadExpiresInDays: req.body.uploadExpiresInDays },
    );
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'Upload link enabled');
  }),
);

// Disable the client-upload link
router.delete('/:id/upload-link',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.disableUploads(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'Upload link disabled');
  }),
);

// Admin download of the whole transfer (ZIP of originals). No expiry/limit
// gate — this is the operator retrieving their own bundle.
router.get('/:id/download',
  requirePermission('photos.download'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.getTransfer(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    // getTransfer returns the serialized view; streamTransferArchive only needs
    // { id, title }, both present on it.
    await transferService.streamTransferArchive(transfer, res);
  }),
);

// Admin download of a single client-uploaded file
router.get('/:id/uploads/:uploadId/download',
  requirePermission('events.view'),
  [param('id').isInt({ min: 1 }), param('uploadId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const upload = await transferService.getUpload(
      parseInt(req.params.id, 10), parseInt(req.params.uploadId, 10),
    );
    if (!upload) return res.status(404).json({ error: 'Upload not found' });
    res.setHeader('Content-Type', upload.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(upload.original_filename)}"`);
    if (upload.localPath && fs.existsSync(upload.localPath)) {
      return fs.createReadStream(upload.localPath).pipe(res);
    }
    // S3 / non-local backend: stream via the storage abstraction.
    const { getStorage } = require('../services/storage');
    const stream = await getStorage().get(upload.stored_path);
    return stream.pipe(res);
  }),
);

module.exports = router;

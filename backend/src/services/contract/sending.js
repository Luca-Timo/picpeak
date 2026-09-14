// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { getAppSetting } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { hasColumnCached } = require('../../utils/schemaCache');
const { formatShortDate } = require('../../utils/dateFormatter');
const pdfService = require('../pdfService');
const emailProcessor = require('../emailProcessor');
const { ensureContractEmailTemplatesSeeded } = require('../contractEmailTemplates');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { adminActor, emitContractEvent, ensureCustomerActive } = require('./helpers');
const { buildRenderContext } = require('./renderContext');
const { persistContractPdf } = require('./signatureAssets');
const { getContractById } = require('./crud');


/**
 * Render PDF for a saved contract (preview before send, or re-render
 * after signing).
 */
async function renderContractPdfBuffer(contractId) {
  const data = await getContractById(contractId);
  if (!data) throw new AppError('Contract not found', 404);
  const ctx = await buildRenderContext(data.contract, data.inclusions, data.textSections);
  return await pdfService.renderContractToBuffer(ctx);
}

/**
 * Send the contract: snapshot every included block's body, render PDF,
 * persist, mint a signing token, queue the customer email.
 */
async function sendContract(id, adminId) {
  // Self-heal: dev installs that ran migration 130 BEFORE we added
  // contract_fully_signed to the seed list won't have all three
  // contract templates in email_templates. Insert any missing rows
  // before we queue the email. Idempotent + module-cached.
  await ensureContractEmailTemplatesSeeded(db, logger);

  const data = await getContractById(id);
  if (!data) throw new AppError('Contract not found', 404);
  const { contract, inclusions } = data;

  if (!['draft'].includes(contract.status)) {
    throw new AppError(`Cannot send a contract with status '${contract.status}'`, 409);
  }

  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);

  // Snapshot every included block's body into the inclusion row so
  // future block edits don't mutate the sent contract — in every language
  // (#1445; only EN and DE were frozen). Text a template already froze into
  // the contract stays as it is.
  const content = require('./content');
  await db.transaction(async (trx) => {
    for (const inc of inclusions) {
      if (!(inc.included === true || inc.included === 1 || inc.included === '1')) continue;
      const frozen = content.inclusionSnapshot(inc);
      await trx('contract_block_inclusions').where({ id: inc.id }).update({
        ...content.snapshotColumns(Object.keys(frozen).length ? frozen : content.blockBodies(inc, 'block_')),
        updated_at: new Date(),
      });
    }
  });

  // Freeze the resolved content — clauses in every language, title, intro,
  // outro and the placeholder values of this moment — with its sha256
  // (#1445). The PDF, the signing page and later re-renders read this.
  const frozenDraft = await getContractById(id);
  const { snapshot, sha256: contentSha256 } = await require('./renderContext')
    .buildContentSnapshot(frozenDraft.contract, frozenDraft.inclusions, frozenDraft.textSections);
  await db('contracts').where({ id }).update({
    rendered_content: JSON.stringify(snapshot),
    rendered_content_sha256: contentSha256,
    updated_at: new Date(),
  });

  // Re-fetch with snapshots populated so the renderer uses the frozen
  // bodies (matches post-send reads).
  const refreshed = await getContractById(id);
  const ctx = await buildRenderContext(refreshed.contract, refreshed.inclusions, refreshed.textSections);
  // Where each signature slot landed goes into the record (#1445).
  const { buffer: rendered, slots } = await pdfService.renderContractWithSlots(ctx);
  // Attachments (#1445): merged ones go between the body and the signature
  // page, separate ones are delivered next to the PDF; each is checked
  // against the sha256 the contract recorded for it.
  const attachments = require('./attachments');
  const sendable = await attachments.buildSendable(refreshed.contract, rendered, { slots });
  const { filePath: pdfPath, sha256: pdfSha256 } = await persistContractPdf(refreshed.contract, sendable.buffer, '', {
    kind: 'unsigned',
    theme: ctx.theme,
    issuer: ctx.issuer,
    templateVersionId: refreshed.contract.template_version_id,
    manifest: sendable.manifest,
  });

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = contract.valid_until
    ? new Date(new Date(contract.valid_until).getTime() + 14 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  // Schema-drift guard for the new pdf_sha256 column (migration 130
  // in-place edit). Dev installs that haven't re-migrated skip the
  // hash write; the send still succeeds.
  const hasPdfSha = await hasColumnCached('contracts', 'pdf_sha256');

  await db.transaction(async (trx) => {
    await trx('contract_action_tokens').insert({
      contract_id: id,
      token,
      expires_at: expiresAt,
      created_at: new Date(),
    });
    const updates = {
      status: 'sent',
      sent_at: new Date(),
      pdf_path: pdfPath,
      updated_at: new Date(),
    };
    if (hasPdfSha) updates.pdf_sha256 = pdfSha256;
    await trx('contracts').where({ id }).update(updates);
  });

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  const responseUrl = `${frontendUrl}/contract/${token}`;
  // Honour the admin's "Attach contract PDF to email" toggle. Default
  // ON; an admin who prefers a link-only email turns it off and the
  // customer reaches the PDF via the public sign page instead.
  const attachPdf = await getAppSetting('crm_contracts_pdf_attachment_enabled');
  const emailAttachments = [
    ...((attachPdf !== false && pdfPath) ? [{
      filename: `${contract.contract_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }] : []),
    // Attachments delivered as separate files (#1445).
    ...sendable.separate.map((file) => ({
      filename: attachments.downloadName(file.name),
      contentPath: file.path,
      contentType: 'application/pdf',
    })),
  ];
  await emailProcessor.queueEmail(null, customer.email, 'contract_sent', {
    contract_number: contract.contract_number,
    customer_name: customer.display_name
      || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
      || customer.email.split('@')[0],
    response_url: responseUrl,
    title: contract.title || '',
    event_name: contract.event_name || '',
    valid_until: formatShortDate(contract.valid_until),
    attachments: emailAttachments.length ? emailAttachments : undefined,
  });

  try {
    await logActivity('contract_sent', { contractId: id, token }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  await emitContractEvent(contract, 'sent');

  logger.info('Contract sent', { adminId, contractId: id });
  return { token, pdfPath };
}
module.exports = {
  renderContractPdfBuffer,
  sendContract,
};

/**
 * Incoming-mail intake (migration 128). Polls the configured IMAP mailbox
 * every minute, parses each unseen message, and drops PDF/image attachments
 * into the incoming-invoices inbox (inbound_documents, source='email').
 *
 * Gated by the `incomingMail` feature flag. Idempotent: each message is logged
 * in received_emails keyed by message-id (skip if seen); duplicate attachments
 * are caught downstream by the inbound_documents SHA-256 dedup. Handles
 * forwarded messages because mailparser flattens nested attachments.
 */
const fsp = require('fs').promises;
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStoragePath } = require('../config/storage');
const expenseService = require('./expenseService');

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];
let polling = false;

// Fail fast instead of hanging on a wrong host/port (e.g. IMAP pointed at an
// SMTP port). Without these, ImapFlow waits indefinitely and the HTTP request
// dies at the proxy as a 502 with no useful message.
const IMAP_TIMEOUTS = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 };

function makeImapClient(cfg) {
  return new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false, ...IMAP_TIMEOUTS });
}

/** Connect with a hard ceiling, so a stuck TLS handshake can't hang forever. */
async function connectWithTimeout(client, ms = 12000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IMAP connection timed out')), ms); });
  try {
    await Promise.race([client.connect(), timeout]);
  } catch (err) {
    // Best-effort teardown if connect lost the race but is still pending.
    try { await client.logout(); } catch (_) { /* noop */ }
    try { client.close(); } catch (_) { /* noop */ }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function isEnabled() {
  const flag = await db('feature_flags').where({ key: 'incomingMail' }).first();
  return !!(flag && (flag.value === true || flag.value === 1 || flag.value === '1'));
}

async function getImapConfig() {
  const c = await db('email_configs').first();
  if (!c || !c.imap_host || !c.imap_user) return null;
  return {
    host: c.imap_host,
    port: c.imap_port || 993,
    secure: c.imap_secure !== false && c.imap_secure !== 0,
    auth: { user: c.imap_user, pass: c.imap_pass || '' },
    folder: c.imap_folder || 'INBOX',
  };
}

async function saveAttachment(att) {
  const year = new Date().getFullYear();
  const dir = path.join(getStoragePath(), 'business-docs', 'inbound', String(year));
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(att.filename || '')
    || (att.contentType === 'application/pdf' ? '.pdf' : att.contentType === 'image/png' ? '.png' : '.jpg');
  const filePath = path.join(dir, `email-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`);
  await fsp.writeFile(filePath, att.content);
  return filePath;
}

/**
 * List the mailbox folders on the IMAP server so the UI can offer a
 * dropdown instead of a free-text path. Uses the saved config; an
 * `override` ({ host, port, secure, user, pass }) lets the admin detect
 * folders BEFORE saving. A masked/blank override password falls back to
 * the stored one. Returns [{ path, name, specialUse }] (specialUse like
 * '\\Inbox' lets the caller auto-select the inbox).
 */
async function listFolders(override) {
  let cfg;
  if (override && override.host && override.user) {
    cfg = {
      host: override.host,
      port: override.port || 993,
      secure: override.secure !== false && override.secure !== 0,
      auth: { user: override.user, pass: override.pass || '' },
    };
    if (!cfg.auth.pass || cfg.auth.pass === '********') {
      const stored = await getImapConfig();
      cfg.auth.pass = stored?.auth?.pass || '';
    }
  } else {
    cfg = await getImapConfig();
  }
  if (!cfg) return [];
  const client = makeImapClient(cfg);
  await connectWithTimeout(client);
  try {
    const list = await client.list();
    return (list || []).map((m) => ({ path: m.path, name: m.name, specialUse: m.specialUse || null }));
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Test the IMAP connection: log in, open the configured folder, and report
 * the message + unread counts. Non-destructive (marks nothing seen, ingests
 * nothing) — proves host/port/user/pass AND that the chosen folder opens.
 * Accepts an `override` ({ host, port, secure, user, pass, folder }) so the
 * admin can test before saving; a masked/blank password falls back to stored.
 */
async function testConnection(override) {
  let cfg; let folder;
  if (override && override.host && override.user) {
    cfg = {
      host: override.host,
      port: override.port || 993,
      secure: override.secure !== false && override.secure !== 0,
      auth: { user: override.user, pass: override.pass || '' },
    };
    folder = override.folder || 'INBOX';
    if (!cfg.auth.pass || cfg.auth.pass === '********') {
      const stored = await getImapConfig();
      cfg.auth.pass = stored?.auth?.pass || '';
    }
  } else {
    const c = await getImapConfig();
    if (!c) return { ok: false, error: 'unconfigured' };
    cfg = { host: c.host, port: c.port, secure: c.secure, auth: c.auth };
    folder = c.folder;
  }
  const client = makeImapClient(cfg);
  await connectWithTimeout(client);
  try {
    const status = await client.status(folder, { messages: true, unseen: true });
    return { ok: true, folder, messages: status.messages || 0, unseen: status.unseen || 0 };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * End-to-end round-trip test: send a uniquely-tagged email through the saved
 * SMTP (outgoing) config TO the IMAP mailbox, then poll IMAP until it arrives.
 * Proves the whole pipeline (outgoing delivery → incoming reception) in one
 * click. Uses SAVED config for both sides (real passwords needed to send +
 * read). Cleans up: the test message is deleted once found, so it never
 * reaches the accounting inbox.
 *
 * Returns { ok, seconds, recipient } on success, or { ok:false, sent, reason }.
 */
async function roundTripTest({ timeoutMs = 30000, intervalMs = 3000 } = {}) {
  const nodemailer = require('nodemailer');
  const crypto = require('crypto');
  const c = await db('email_configs').first();
  if (!c || !c.smtp_host || !c.smtp_port) return { ok: false, sent: false, reason: 'smtp_unconfigured' };
  if (!c.imap_host || !c.imap_user) return { ok: false, sent: false, reason: 'imap_unconfigured' };

  // Recipient = the mailbox we poll. imap_user is the mailbox address in the
  // typical setup (e.g. rechnungen@…). NOT hardcoded — but some hosts use a
  // non-email IMAP login, in which case we can't auto-address the test.
  const recipient = c.imap_user;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient || '')) {
    return { ok: false, sent: false, reason: 'recipient_not_email', recipient };
  }
  const token = `ppk-rt-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const subject = `picpeak round-trip test ${token}`;

  // 1) Send via the saved SMTP config (mirror the /test route's transport).
  const transporter = nodemailer.createTransport({
    host: c.smtp_host,
    port: parseInt(c.smtp_port, 10),
    secure: c.smtp_secure === true || c.smtp_secure === 1,
    auth: c.smtp_user && c.smtp_pass ? { user: c.smtp_user, pass: c.smtp_pass } : undefined,
    tls: { rejectUnauthorized: c.tls_reject_unauthorized !== false },
  });
  try {
    await transporter.sendMail({
      from: `${c.from_name || 'picpeak'} <${c.from_email || c.smtp_user}>`,
      to: recipient,
      subject,
      text: `This is an automated picpeak round-trip test. Token: ${token}. Safe to ignore — it is deleted automatically.`,
    });
  } catch (err) {
    return { ok: false, sent: false, reason: 'send_failed', error: err.message };
  }

  // 2) Poll IMAP for the tagged message until timeout.
  const cfg = await getImapConfig();
  const folder = cfg?.folder || 'INBOX';
  const client = makeImapClient(cfg);
  await connectWithTimeout(client);
  const started = Date.now();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ subject: token }, { uid: true });
        if (uids && uids.length) {
          await client.messageDelete(uids, { uid: true }).catch(() => {});
          return { ok: true, seconds: Math.round((Date.now() - started) / 1000), recipient };
        }
      } finally {
        lock.release();
      }
      if (Date.now() - started > timeoutMs) {
        return { ok: false, sent: true, reason: 'not_received', recipient };
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Poll the mailbox once. Safe to call repeatedly; self-skips when busy/off. */
async function pollOnce() {
  if (polling) return { skipped: 'busy' };
  if (!(await isEnabled())) return { skipped: 'disabled' };
  const cfg = await getImapConfig();
  if (!cfg) return { skipped: 'unconfigured' };

  polling = true;
  const client = makeImapClient(cfg);
  let processed = 0;
  try {
    await connectWithTimeout(client);
    const lock = await client.getMailboxLock(cfg.folder);
    try {
      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const messageId = parsed.messageId || `uid-${cfg.folder}-${msg.uid}`;
          const seen = await db('received_emails').where({ message_id: messageId }).first();
          if (seen) { await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }); continue; }

          const atts = (parsed.attachments || []).filter((a) => ALLOWED_MIME.includes(a.contentType));
          let inboundId = null;
          let count = 0;
          for (const att of atts) {
            // eslint-disable-next-line no-await-in-loop
            const filePath = await saveAttachment(att);
            // eslint-disable-next-line no-await-in-loop
            const doc = await expenseService.recordInboundDocument({ source: 'email', filePath, originalFilename: att.filename || 'attachment', mimeType: att.contentType }, null);
            inboundId = doc.id; count += 1;
          }
          await db('received_emails').insert({
            message_id: messageId,
            from_address: (parsed.from && parsed.from.text) || null,
            subject: parsed.subject || null,
            received_at: parsed.date || new Date(),
            attachment_count: count,
            status: count > 0 ? 'ingested' : 'no_attachment',
            inbound_document_id: inboundId,
            created_at: new Date(),
          });
          await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          processed += 1;
        } catch (e) {
          logger.error?.(`emailIntake: message uid ${msg.uid} failed: ${e.message}`);
          try {
            await db('received_emails').insert({ message_id: `err-${msg.uid}-${Date.now()}`, status: 'error', error: e.message, attachment_count: 0, received_at: new Date(), created_at: new Date() });
          } catch (_e) { /* ignore */ }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    logger.error?.(`emailIntake: poll failed: ${e.message}`);
    try { await client.close(); } catch (_e) { /* ignore */ }
  } finally {
    polling = false;
  }
  return { processed };
}

/** Start the 1-minute poll loop (mirrors the outgoing queue cadence). */
function startIncomingMailPoller() {
  const run = () => pollOnce().catch((e) => logger.error?.(`emailIntake: ${e.message}`));
  setTimeout(run, 15000); // first run shortly after boot
  setInterval(run, 60 * 1000);
  logger.info?.('Incoming-mail poller started (every 60s when enabled)');
}

module.exports = { pollOnce, startIncomingMailPoller, listFolders, testConnection, roundTripTest, _internal: { getImapConfig, isEnabled, saveAttachment } };

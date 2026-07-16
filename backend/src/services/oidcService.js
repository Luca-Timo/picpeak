/**
 * OIDC SSO for admin users (#798, phase 1).
 *
 * Authorization-code + PKCE against a single configurable IdP (Keycloak,
 * Authentik, Pocket ID, or any spec-compliant provider). Scope is deliberately
 * narrow in phase 1: admin logins only, JIT provisioning with one default
 * role. Role-claim mapping and logout-to-IdP are follow-ups.
 *
 * Identity binding: SSO logins match on `admin_users.external_subject` (the
 * IdP's stable `sub` claim) — NEVER on email alone, which is an
 * account-takeover vector with IdPs that don't verify addresses. A one-time
 * link of an EXISTING local admin by email is allowed only when the ID token
 * carries `email_verified: true`; the sub is stamped so all future logins
 * match by sub even if the email changes. Linked local admins keep
 * `auth_provider='local'` (their password still works); JIT-provisioned rows
 * get `auth_provider='oidc'` and an unusable random password hash.
 *
 * Config lives in app_settings (oidc_* keys, managed via the dedicated
 * /admin/settings/sso endpoints). The client secret is AES-256-GCM encrypted
 * at rest — same construction as mfaService, own salt, key from
 * OIDC_ENCRYPTION_KEY (fallback JWT_SECRET).
 *
 * MFA is delegated to the IdP for SSO logins: local TOTP protects the local
 * password path, which SSO users don't take.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
// openid-client v5 (CommonJS). v6+ is ESM-only, which Node 22 can require()
// but Jest's CJS runtime cannot — v5 is the battle-tested major and its
// protocol coverage (discovery, PKCE, full ID-token validation) is identical
// for our flow.
const { Issuer, generators } = require('openid-client');
const { db } = require('../database/db');
const { getAppSetting, upsertAppSetting } = require('../utils/appSettings');
const { formatBoolean } = require('../utils/dbCompat');
const { getBcryptRounds } = require('../utils/passwordValidation');
const logger = require('../utils/logger');

const ENC_ALGO = 'aes-256-gcm';
const ENC_SALT = 'picpeak-oidc-secret-v1'; // fixed: derivation must be stable

function getEncryptionKey() {
  const material = process.env.OIDC_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!material) {
    throw new Error('oidcService: OIDC_ENCRYPTION_KEY or JWT_SECRET must be set');
  }
  return crypto.scryptSync(material, ENC_SALT, 32);
}

/** AES-256-GCM encrypt → "iv.tag.ciphertext" (all base64url). */
function encryptSecret(plainSecret) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

/** Reverse of encryptSecret. Throws on tamper/wrong key. */
function decryptSecret(stored) {
  const key = getEncryptionKey();
  const [ivB64, tagB64, ctB64] = String(stored).split('.');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('oidcService: malformed encrypted secret');
  }
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Read the full OIDC config from app_settings. Secret is returned DECRYPTED —
 * for internal use only; the settings GET endpoint must never call this.
 */
async function getOidcConfig() {
  const [enabled, issuerUrl, clientId, encSecret, autoprovision, defaultRole, buttonLabel, scopes] =
    await Promise.all([
      getAppSetting('oidc_enabled'),
      getAppSetting('oidc_issuer_url'),
      getAppSetting('oidc_client_id'),
      getAppSetting('oidc_client_secret'),
      getAppSetting('oidc_autoprovision'),
      getAppSetting('oidc_default_role'),
      getAppSetting('oidc_button_label'),
      getAppSetting('oidc_scopes'),
    ]);

  let clientSecret = null;
  if (encSecret) {
    try {
      clientSecret = decryptSecret(encSecret);
    } catch (err) {
      // Wrong key / tampered / plaintext-clobbered value → treat as
      // unconfigured rather than sending garbage to the IdP.
      logger.error('OIDC client secret could not be decrypted — treating SSO as unconfigured', {
        error: err.message,
      });
    }
  }

  return {
    enabled: enabled === true,
    issuerUrl: issuerUrl || null,
    clientId: clientId || null,
    clientSecret,
    autoprovision: autoprovision === true,
    defaultRole: defaultRole || 'viewer',
    buttonLabel: buttonLabel || null,
    scopes: scopes || 'openid profile email',
  };
}

function isConfigured(cfg) {
  return Boolean(cfg.issuerUrl && cfg.clientId && cfg.clientSecret);
}

// Discovery result cache. Keyed by issuer+client so a settings change gets a
// fresh client; invalidated explicitly on settings save too.
let _clientCache = null; // { key, client, issuerMetadata }

function invalidateDiscoveryCache() {
  _clientCache = null;
}

/**
 * Resolve the openid-client Client for the current settings, performing
 * OIDC discovery on first use. Throws on unreachable/invalid issuer —
 * callers surface that as a config error.
 */
async function getClient(cfg) {
  const key = `${cfg.issuerUrl}|${cfg.clientId}`;
  if (_clientCache && _clientCache.key === key) {
    return _clientCache;
  }
  const issuer = await Issuer.discover(cfg.issuerUrl);
  const client = new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uris: [await getRedirectUri()],
    response_types: ['code'],
  });
  _clientCache = { key, client, issuerMetadata: issuer.metadata };
  return _clientCache;
}

/**
 * The redirect URI registered with the IdP. Derived from the public frontend
 * base URL — nginx proxies /api to the backend, so this resolves publicly.
 */
async function getRedirectUri() {
  const { getFrontendBaseUrl } = require('../utils/frontendUrl');
  const base = (await getFrontendBaseUrl()).replace(/\/$/, '');
  if (!base) {
    // Without a public base URL the redirect_uri would be relative — the IdP
    // would reject it with an opaque error on ITS side. Fail here with a
    // clear config message instead.
    const err = new Error('FRONTEND_URL (or the general_site_url setting) must be set for SSO');
    err.code = 'OIDC_BAD_CONFIG';
    throw err;
  }
  return `${base}/api/auth/admin/sso/callback`;
}

/**
 * Build the IdP authorization URL plus the per-request secrets the callback
 * needs (state, nonce, PKCE verifier). The route stores those in a
 * short-lived signed cookie — this service is stateless across the redirect.
 */
async function buildAuthorizationRequest() {
  const cfg = await getOidcConfig();
  if (!cfg.enabled || !isConfigured(cfg)) {
    const err = new Error('SSO is not enabled or not fully configured');
    err.code = 'OIDC_NOT_CONFIGURED';
    throw err;
  }
  const { client } = await getClient(cfg);

  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const nonce = generators.nonce();

  const url = client.authorizationUrl({
    redirect_uri: await getRedirectUri(),
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url, state, nonce, codeVerifier };
}

/**
 * Exchange the authorization code and validate the ID token (issuer,
 * audience, signature, nonce, state — all enforced by openid-client).
 * Returns the ID token claims.
 */
async function handleCallback(currentUrl, { state, nonce, codeVerifier }) {
  const cfg = await getOidcConfig();
  if (!cfg.enabled || !isConfigured(cfg)) {
    const err = new Error('SSO is not enabled or not fully configured');
    err.code = 'OIDC_NOT_CONFIGURED';
    throw err;
  }
  const { client } = await getClient(cfg);

  // Extract code/state from the callback URL, then exchange + validate the
  // ID token (issuer, audience, signature, exp, nonce, state — all enforced
  // by openid-client).
  const callbackUrl = new URL(currentUrl);
  const params = Object.fromEntries(callbackUrl.searchParams.entries());
  const tokenSet = await client.callback(await getRedirectUri(), params, {
    state,
    nonce,
    code_verifier: codeVerifier,
  });

  return tokenSet.claims();
}

/**
 * Map validated ID token claims to an admin_users row.
 *
 * Resolution order:
 *   1. external_subject === sub → that admin (must be active).
 *   2. email match against an UNLINKED admin, only if email_verified === true
 *      → one-time link (stamps external_subject; auth_provider unchanged so
 *      a local password keeps working).
 *   3. JIT provisioning when oidc_autoprovision is on (requires an email
 *      claim; role = oidc_default_role; unusable random password).
 *
 * Errors carry a `code` the route maps to a redirect error key.
 */
async function resolveAdminFromClaims(claims) {
  const sub = claims.sub;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
  const emailVerified = claims.email_verified === true;

  if (!sub) {
    const err = new Error('ID token has no sub claim');
    err.code = 'OIDC_BAD_CLAIMS';
    throw err;
  }

  // 1. Established binding.
  const bySub = await db('admin_users').where('external_subject', sub).first();
  if (bySub) {
    if (!bySub.is_active) {
      const err = new Error('Admin account is deactivated');
      err.code = 'OIDC_INACTIVE';
      throw err;
    }
    return bySub;
  }

  // 2. One-time email link — verified emails only, and only onto rows that
  //    have no binding yet (a different sub on the row means a different
  //    IdP identity already owns it).
  if (email && emailVerified) {
    const byEmail = await db('admin_users')
      .where('email', email)
      .whereNull('external_subject')
      .first();
    if (byEmail) {
      if (!byEmail.is_active) {
        const err = new Error('Admin account is deactivated');
        err.code = 'OIDC_INACTIVE';
        throw err;
      }
      await db('admin_users').where('id', byEmail.id).update({
        external_subject: sub,
        updated_at: new Date(),
      });
      logger.info('OIDC: linked existing admin to IdP subject', {
        adminId: byEmail.id,
        sub,
      });
      return { ...byEmail, external_subject: sub };
    }
  }

  // 3. JIT provisioning.
  const cfg = await getOidcConfig();
  if (!cfg.autoprovision) {
    const err = new Error('No matching admin account and auto-provisioning is disabled');
    err.code = 'OIDC_NOT_PROVISIONED';
    throw err;
  }
  if (!email) {
    const err = new Error('IdP supplied no email claim — cannot provision an account');
    err.code = 'OIDC_NO_EMAIL';
    throw err;
  }

  const role = await db('roles').where('name', cfg.defaultRole).first();
  if (!role) {
    const err = new Error(`Configured default role '${cfg.defaultRole}' does not exist`);
    err.code = 'OIDC_BAD_CONFIG';
    throw err;
  }

  // Unusable-but-valid bcrypt hash: local login always fails for this row,
  // and nothing downstream chokes on a malformed hash.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), getBcryptRounds());

  const inserted = await db('admin_users')
    .insert({
      username: email,
      email,
      password_hash: passwordHash,
      role_id: role.id,
      is_active: formatBoolean(true),
      must_change_password: formatBoolean(false),
      auth_provider: 'oidc',
      external_subject: sub,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('id');
  const adminId = inserted[0]?.id || inserted[0];
  logger.info('OIDC: JIT-provisioned admin from IdP', { adminId, sub, role: cfg.defaultRole });

  return db('admin_users').where('id', adminId).first();
}

/**
 * Persist SSO settings (dedicated endpoint — the generic settings upserts
 * strip oidc_client_secret so it can't be clobbered with plaintext).
 * An absent/empty secret keeps the stored one.
 */
async function saveOidcSettings(input) {
  const writes = [];
  const put = (key, value, type) => writes.push(upsertAppSetting(key, JSON.stringify(value), type));

  if (input.oidc_enabled !== undefined) put('oidc_enabled', input.oidc_enabled === true, 'boolean');
  if (input.oidc_issuer_url !== undefined) put('oidc_issuer_url', String(input.oidc_issuer_url).trim(), 'string');
  if (input.oidc_client_id !== undefined) put('oidc_client_id', String(input.oidc_client_id).trim(), 'string');
  if (input.oidc_autoprovision !== undefined) put('oidc_autoprovision', input.oidc_autoprovision === true, 'boolean');
  if (input.oidc_default_role !== undefined) put('oidc_default_role', String(input.oidc_default_role).trim(), 'string');
  if (input.oidc_button_label !== undefined) put('oidc_button_label', String(input.oidc_button_label).trim(), 'string');
  if (input.oidc_scopes !== undefined) put('oidc_scopes', String(input.oidc_scopes).trim() || 'openid profile email', 'string');
  if (typeof input.oidc_client_secret === 'string' && input.oidc_client_secret.length > 0) {
    put('oidc_client_secret', encryptSecret(input.oidc_client_secret), 'string');
  }

  await Promise.all(writes);
  invalidateDiscoveryCache();
}

module.exports = {
  getOidcConfig,
  isConfigured,
  getRedirectUri,
  buildAuthorizationRequest,
  handleCallback,
  resolveAdminFromClaims,
  saveOidcSettings,
  invalidateDiscoveryCache,
  getClient,
  encryptSecret,
  decryptSecret,
};

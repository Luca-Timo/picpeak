/**
 * #868 — the admin gallery-preview gate. isAdminPreview must fail CLOSED: it
 * grants the draft/password bypass only for an explicit `?admin_preview=1` flag
 * AND a verified admin JWT (type 'admin', issuer 'picpeak-auth') read from the
 * httpOnly admin_token cookie or a Bearer header — never from the URL, never for
 * a guest/gallery token.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-preview-test-secret';
const jwt = require('jsonwebtoken');
const { isAdminPreview } = require('../../src/middleware/gallery');

// Read the secret at call time — a jest setup file can set JWT_SECRET after this
// module loads, and isAdminPreview verifies against the live value.
const adminToken = () => jwt.sign({ type: 'admin', id: 1 }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
const galleryToken = () => jwt.sign({ type: 'gallery', eventId: 1 }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });

function req({ flag, cookie, bearer } = {}) {
  return {
    query: flag === undefined ? {} : { admin_preview: flag },
    cookies: cookie ? { admin_token: cookie } : {},
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  };
}

describe('isAdminPreview (#868) fails closed', () => {
  it('false without the explicit flag, even with a valid admin cookie (plain link stays guest-identical)', () => {
    expect(isAdminPreview(req({ cookie: adminToken() }))).toBe(false);
  });

  it('false with the flag but no session token', () => {
    expect(isAdminPreview(req({ flag: '1' }))).toBe(false);
  });

  it('true with the flag + a valid admin cookie', () => {
    expect(isAdminPreview(req({ flag: '1', cookie: adminToken() }))).toBe(true);
  });

  it('true with the flag + a valid admin Bearer header', () => {
    expect(isAdminPreview(req({ flag: '1', bearer: adminToken() }))).toBe(true);
  });

  it('false for a gallery (guest) token — must be type admin', () => {
    expect(isAdminPreview(req({ flag: '1', cookie: galleryToken() }))).toBe(false);
  });

  it('true from the admin cookie even when a gallery Bearer is also present (#981 coexisting session)', () => {
    expect(isAdminPreview(req({ flag: '1', cookie: adminToken(), bearer: galleryToken() }))).toBe(true);
  });

  it('false when only a gallery Bearer is present — a gallery header can never satisfy it (#981)', () => {
    expect(isAdminPreview(req({ flag: '1', bearer: galleryToken() }))).toBe(false);
  });

  it('false on a tampered token', () => {
    expect(isAdminPreview(req({ flag: '1', cookie: `${adminToken()}x` }))).toBe(false);
  });

  it('false on the wrong issuer', () => {
    const t = jwt.sign({ type: 'admin' }, process.env.JWT_SECRET, { issuer: 'not-picpeak' });
    expect(isAdminPreview(req({ flag: '1', cookie: t }))).toBe(false);
  });

  it('false when the flag is anything other than exactly "1"', () => {
    expect(isAdminPreview(req({ flag: 'true', cookie: adminToken() }))).toBe(false);
    expect(isAdminPreview(req({ flag: '0', cookie: adminToken() }))).toBe(false);
  });
});

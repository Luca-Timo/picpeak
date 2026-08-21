/**
 * Unit tests for the public-origin resolver (#705).
 *
 * The zero-touch install depends on this precedence being exactly:
 *   1. FRONTEND_URL, when it is not loopback
 *   2. a purpose-specific override the caller passes (ADMIN_URL, APP_URL)
 *   3. the `general_site_url` setting written by the setup wizard
 *   4. the origin the request arrived on
 *   5. whichever of those exists at all (a genuine localhost install)
 *   6. '' — so callers that build RELATIVE urls keep doing so
 *
 * The loopback demotion in (1) matters because docker-compose used to inject
 * FRONTEND_URL=http://localhost:3000 unconditionally: taking that literally
 * sends every gallery link, QR code and reminder email to the RECIPIENT's own
 * machine. The empty return in (5) is load-bearing too — shareLinkService and
 * the SSO redirects in routes/auth treat it as "emit a relative url".
 */

// `mock`-prefixed so jest's out-of-scope guard allows the factory to close
// over it; the same fn is reused across resetModules() so assertions on call
// counts survive a reload.
const mockDb = jest.fn();
jest.mock('../database/db', () => ({ db: mockDb }));

const db = mockDb;

// Mimic knex's builder for: db('app_settings').where(...).select(...).first()
const settingRow = (value) => ({
  where: () => ({ select: () => ({ first: async () => (value === undefined ? undefined : { setting_value: JSON.stringify(value) }) }) }),
});

const fakeReq = (host, protocol = 'http') => ({ protocol, get: (h) => (h === 'host' ? host : undefined) });

// resetModules() clears the resolver's cached setting between cases; the
// jest.mock registration above survives it.
const loadModule = () => {
  jest.resetModules();
  return require('../utils/frontendUrl');
};

describe('getFrontendBaseUrl precedence', () => {
  beforeEach(() => {
    delete process.env.FRONTEND_URL;
    delete process.env.API_URL;
    db.mockReset();
  });

  it('prefers a non-loopback FRONTEND_URL and never touches the database', async () => {
    process.env.FRONTEND_URL = 'https://pinned.example.com';
    db.mockImplementation(() => settingRow('https://setting.example.com'));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl()).toBe('https://pinned.example.com');
    expect(db).not.toHaveBeenCalled();
  });

  it('demotes a loopback FRONTEND_URL in favour of the configured setting', async () => {
    process.env.FRONTEND_URL = 'http://localhost:3000';
    db.mockImplementation(() => settingRow('http://192.168.1.50:3000'));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl()).toBe('http://192.168.1.50:3000');
  });

  it('uses the wizard setting when the environment is untouched', async () => {
    db.mockImplementation(() => settingRow('https://gallery.example.com'));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl()).toBe('https://gallery.example.com');
  });

  it('falls back to the origin the request arrived on', async () => {
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl(fakeReq('192.168.1.77:3000'))).toBe('http://192.168.1.77:3000');
  });

  it('honours X-Forwarded-Proto via req.protocol', async () => {
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl(fakeReq('gallery.example.com', 'https'))).toBe('https://gallery.example.com');
  });

  it('returns empty when nothing is configured, so callers can go relative', async () => {
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl()).toBe('');
  });

  it('still resolves a genuine localhost install rather than returning empty', async () => {
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl(fakeReq('localhost:3000'))).toBe('http://localhost:3000');
  });

  it('strips trailing slashes', async () => {
    process.env.FRONTEND_URL = 'https://pinned.example.com///';
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl()).toBe('https://pinned.example.com');
  });
});

describe('getAbsoluteFrontendUrl', () => {
  beforeEach(() => {
    delete process.env.FRONTEND_URL;
    delete process.env.API_URL;
    db.mockReset();
  });

  it('ends at localhost:3000 when nothing is configured and there is no request', async () => {
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getAbsoluteFrontendUrl()).toBe('http://localhost:3000');
  });
});

describe('getApiBaseUrl', () => {
  beforeEach(() => {
    delete process.env.FRONTEND_URL;
    delete process.env.API_URL;
    db.mockReset();
  });

  it('prefers an explicit API_URL for split-origin deployments', async () => {
    process.env.API_URL = 'https://api.example.com';
    db.mockImplementation(() => settingRow('https://gallery.example.com'));
    const m = loadModule();

    expect(await m.getApiBaseUrl()).toBe('https://api.example.com');
  });

  it('otherwise derives /api from the resolved origin', async () => {
    db.mockImplementation(() => settingRow('https://gallery.example.com'));
    const m = loadModule();

    expect(await m.getApiBaseUrl()).toBe('https://gallery.example.com/api');
  });
});

describe('purpose-specific env override (ADMIN_URL / APP_URL)', () => {
  beforeEach(() => { delete process.env.FRONTEND_URL; db.mockReset(); });

  it('beats the general_site_url setting, so a split-origin admin host wins', async () => {
    db.mockImplementation(() => settingRow('https://gallery.example.com'));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl(null, { override: 'https://admin.example.com' }))
      .toBe('https://admin.example.com');
  });

  it('beats the request origin too', async () => {
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl(fakeReq('gallery.example.com', 'https'), { override: 'https://admin.example.com' }))
      .toBe('https://admin.example.com');
  });

  it('still sits below FRONTEND_URL, preserving the historic order', async () => {
    process.env.FRONTEND_URL = 'https://pinned.example.com';
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl(null, { override: 'https://admin.example.com' }))
      .toBe('https://pinned.example.com');
  });

  it('is demoted when it is loopback, like every other candidate', async () => {
    db.mockImplementation(() => settingRow('https://gallery.example.com'));
    const m = loadModule();

    expect(await m.getFrontendBaseUrl(null, { override: 'http://localhost:3005' }))
      .toBe('https://gallery.example.com');
  });

  it('is used by getAbsoluteFrontendUrl ahead of the terminal fallback', async () => {
    db.mockImplementation(() => settingRow(undefined));
    const m = loadModule();

    expect(await m.getAbsoluteFrontendUrl(null, { override: 'https://admin.example.com' }))
      .toBe('https://admin.example.com');
  });
});

describe('isEnvPinned', () => {
  beforeEach(() => { delete process.env.FRONTEND_URL; db.mockReset(); });

  it('reports the environment override so the admin UI can go read-only', async () => {
    db.mockImplementation(() => settingRow(undefined));
    let m = loadModule();
    expect(m.isEnvPinned()).toBe(false);

    process.env.FRONTEND_URL = 'https://pinned.example.com';
    m = loadModule();
    expect(m.isEnvPinned()).toBe(true);
  });

  // The upgrade case this whole PR exists for: an install still carrying the
  // old compose default. The resolver demotes it, so the admin UI must NOT
  // lock the Site URL field — otherwise that operator can never configure a
  // public address anywhere (#1104).
  it('does NOT report a loopback FRONTEND_URL as pinned', () => {
    process.env.FRONTEND_URL = 'http://localhost:3000';
    const m = loadModule();

    expect(m.isEnvPinned()).toBe(false);
    expect(m.envPinnedBase()).toBe('');
  });

  it('exposes the effective pinned value, normalised', () => {
    process.env.FRONTEND_URL = 'https://pinned.example.com/// ';
    const m = loadModule();

    expect(m.envPinnedBase()).toBe('https://pinned.example.com');
  });
});

describe('isLoopbackBase', () => {
  it.each([
    ['http://localhost:3000', true],
    ['http://127.0.0.1:8080', true],
    ['http://0.0.0.0:3000', true],
    ['http://[::1]:3000', true],
    ['http://192.168.1.50:3000', false],
    ['https://gallery.example.com', false],
    ['', false],
  ])('%s → %s', (url, expected) => {
    const m = loadModule();
    expect(m.isLoopbackBase(url)).toBe(expected);
  });
});

/**
 * In-app updates, backend half (docs/self-update.md, issue 1776).
 *
 * The backend only takes a database dump and then creates
 * update/request/update-requested; the updater does the rest. These cases pin
 * the gates in front of that file: PICPEAK_SELF_UPDATE=true, super_admin, the
 * password again, a limiter on wrong guesses, and "busy" while an update is in
 * flight. They also pin that no request is filed when the dump fails.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-selfupdate-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'selfupdate-test-secret';

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');

const PASSWORD = 'Passw0rd!-update';

describe('/admin/system/updates/self-update', () => {
  let db; let cleanup; let app; let updateDir;
  let selfUpdateService; let databaseBackupService;
  const tokens = {};

  const statusPath = () => path.join(updateDir, 'status', 'status.json');
  const requestPath = () => path.join(updateDir, 'request', 'update-requested');

  const writeAgentStatus = (fields) => fs.writeFileSync(statusPath(), JSON.stringify({
    contract: 1,
    updater_version: '1.0.0',
    packaging: 'host',
    state: 'idle',
    ...fields,
  }));

  const makeAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const inserted = await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash(PASSWORD, 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    return jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
  };

  const getStatus = (who = 'super') => request(app)
    .get('/admin/system/updates/self-update')
    .set('Authorization', `Bearer ${tokens[who]}`);

  const requestUpdate = (who = 'super', password = PASSWORD) => request(app)
    .post('/admin/system/updates/self-update')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send({ password });

  // The job runs after the 202; wait until it leaves `backing_up`.
  const settled = async () => {
    for (let i = 0; i < 100; i += 1) {
      if (!selfUpdateService.jobActive()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('self-update job did not settle');
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    selfUpdateService = require('../../src/services/selfUpdateService');
    ({ databaseBackupService } = require('../../src/services/databaseBackup'));

    tokens.super = await makeAdmin('update-super', 'super_admin');
    tokens.super2 = await makeAdmin('update-super-2', 'super_admin');
    tokens.admin = await makeAdmin('update-admin', 'admin');

    app = buildRouteApp('/admin/system', require('../../src/routes/adminSystem'));
  }, 120000);

  afterAll(async () => { await cleanup(); });

  beforeEach(() => {
    updateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-update-dir-'));
    fs.mkdirSync(path.join(updateDir, 'request'));
    fs.mkdirSync(path.join(updateDir, 'status'));
    process.env.PICPEAK_UPDATE_DIR = updateDir;
    process.env.PICPEAK_SELF_UPDATE = 'true';
    selfUpdateService._reset();
    jest.spyOn(databaseBackupService, 'backup').mockResolvedValue({
      success: true, path: '/backup/database/picpeak-db-20261005.sql.gz', size: 1234,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.PICPEAK_SELF_UPDATE;
    fs.rmSync(updateDir, { recursive: true, force: true });
  });

  describe('status', () => {
    it('is unavailable unless PICPEAK_SELF_UPDATE is exactly "true"', async () => {
      writeAgentStatus({});
      for (const value of [undefined, '1', 'TRUE', 'yes']) {
        if (value === undefined) delete process.env.PICPEAK_SELF_UPDATE;
        else process.env.PICPEAK_SELF_UPDATE = value;
        const res = await getStatus();
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ enabled: false, available: false, reason: 'disabled', agent: null });
      }
    });

    it('is unavailable without an updater status file', async () => {
      const res = await getStatus();
      expect(res.body).toMatchObject({ enabled: true, available: false, reason: 'no_agent' });
    });

    it('is available with an idle updater, and says who may request it', async () => {
      writeAgentStatus({});
      const res = await getStatus();
      expect(res.body).toMatchObject({ available: true, reason: null, can_request: true });
      expect(res.body.agent).toMatchObject({ contract: 1, state: 'idle', packaging: 'host', updater_version: '1.0.0' });

      const asAdmin = await getStatus('admin');
      expect(asAdmin.body).toMatchObject({ available: true, can_request: false });
    });

    it('refuses an updater that speaks another contract', async () => {
      writeAgentStatus({ contract: 2 });
      const res = await getStatus();
      expect(res.body).toMatchObject({ available: false, reason: 'unsupported_contract' });
    });

    it('passes only known fields and known states through', async () => {
      writeAgentStatus({ state: 'pwned', message: 'x'.repeat(5000), extra: '<script>' });
      const res = await getStatus();
      expect(res.body.agent.state).toBeNull();
      expect(res.body.agent.message).toHaveLength(2000);
      expect(res.body.agent).not.toHaveProperty('extra');
    });

    it('ignores a status file that is not JSON or is oversized', async () => {
      fs.writeFileSync(statusPath(), 'not json');
      expect((await getStatus()).body.reason).toBe('no_agent');
      fs.writeFileSync(statusPath(), JSON.stringify({ contract: 1, state: 'idle', pad: 'y'.repeat(70 * 1024) }));
      expect((await getStatus()).body.reason).toBe('no_agent');
    });

    it('is busy while the updater runs or a request is pending', async () => {
      writeAgentStatus({ state: 'running', step: 'pull' });
      expect((await getStatus()).body).toMatchObject({ available: false, reason: 'busy' });

      writeAgentStatus({ state: 'succeeded' });
      fs.writeFileSync(requestPath(), '');
      expect((await getStatus()).body).toMatchObject({ available: false, reason: 'busy' });
    });
  });

  describe('request', () => {
    it('takes the database dump, then files the request', async () => {
      writeAgentStatus({});
      const res = await requestUpdate();
      expect(res.status).toBe(202);
      expect(res.body.job).toMatchObject({ phase: 'backing_up', requested_by: 'update-super' });

      await settled();
      expect(databaseBackupService.backup).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(requestPath())).toBe(true);
      // Only the marker: no temp file left beside it.
      expect(fs.readdirSync(path.dirname(requestPath()))).toEqual(['update-requested']);

      const status = await getStatus();
      expect(status.body.job).toMatchObject({
        phase: 'requested',
        backup: { file: 'picpeak-db-20261005.sql.gz', size: 1234 },
      });
      expect(status.body.reason).toBe('busy');

      const logged = await db('activity_logs').where({ activity_type: 'self_update_requested' }).first();
      expect(logged).toBeTruthy();
      expect(logged.actor_name).toBe('update-super');
    });

    it('files nothing when the database dump fails', async () => {
      writeAgentStatus({});
      databaseBackupService.backup.mockRejectedValueOnce(new Error('disk full'));
      expect((await requestUpdate()).status).toBe(202);
      await settled();
      expect(fs.existsSync(requestPath())).toBe(false);
      const status = await getStatus();
      expect(status.body.job).toMatchObject({ phase: 'backup_failed', error: 'disk full' });
      // A failed attempt does not block the next one.
      expect(status.body.available).toBe(true);
    });

    it('reports a request file it could not write', async () => {
      writeAgentStatus({});
      fs.rmSync(path.join(updateDir, 'request'), { recursive: true });
      expect((await requestUpdate()).status).toBe(202);
      await settled();
      expect((await getStatus()).body.job.phase).toBe('request_failed');
    });

    it('is refused while disabled, before the password is even checked', async () => {
      writeAgentStatus({});
      delete process.env.PICPEAK_SELF_UPDATE;
      const res = await requestUpdate('super', 'wrong');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SELF_UPDATE_DISABLED');
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
    });

    it('needs super_admin', async () => {
      writeAgentStatus({});
      const res = await requestUpdate('admin');
      expect(res.status).toBe(403);
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
    });

    it('is refused while busy, without a second dump', async () => {
      writeAgentStatus({ state: 'running' });
      const res = await requestUpdate();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SELF_UPDATE_BUSY');
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
    });

    it('is refused without an updater', async () => {
      const res = await requestUpdate();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SELF_UPDATE_NO_AGENT');
    });

    it('needs the password, and limits wrong guesses per admin', async () => {
      writeAgentStatus({});
      expect((await requestUpdate('super2', '')).status).toBe(400);
      for (let i = 0; i < 4; i += 1) {
        const res = await requestUpdate('super2', 'wrong');
        // Not 401: the admin client treats that as an expired session.
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SELF_UPDATE_BAD_PASSWORD');
      }
      const limited = await requestUpdate('super2', PASSWORD);
      expect(limited.status).toBe(429);
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
      expect(fs.existsSync(requestPath())).toBe(false);
    });
  });
});

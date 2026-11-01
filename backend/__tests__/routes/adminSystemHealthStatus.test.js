const express = require('express');
const request = require('supertest');

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, res, next) => (req.headers.authorization ? next() : res.status(401).json({ error: 'Unauthorized' })),
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (req, res, next) => (req.headers['x-denied'] ? res.status(403).json({ error: 'Forbidden' }) : next()),
}));

const dependencyHealth = require('../../src/services/dependencyHealth');
const router = require('../../src/routes/adminSystemHealth');

const app = express();
app.use('/api/admin/system-health', router);

describe('GET /api/admin/system-health/status', () => {
  it('answers from memory, without touching the database', async () => {
    dependencyHealth.applyProbe('storage', { state: 'healthy' });
    const res = await request(app).get('/api/admin/system-health/status').set('Authorization', 'Bearer x');
    expect(res.status).toBe(200);
    expect(res.body.enforcement).toBe('observe');
    expect(res.body.dependencies.storage.state).toBe('healthy');
    expect(res.body.capabilities.map((c) => c.name)).toContain('uploads.new');
  });

  it('refuses an anonymous caller, since probe details can name hosts', async () => {
    const res = await request(app).get('/api/admin/system-health/status');
    expect(res.status).toBe(401);
    expect(res.body.dependencies).toBeUndefined();
  });

  it('refuses an admin without the permission', async () => {
    const res = await request(app).get('/api/admin/system-health/status')
      .set('Authorization', 'Bearer x').set('x-denied', '1');
    expect(res.status).toBe(403);
  });
});

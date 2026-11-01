/**
 * A mail server outage must not use up a mail's attempts. The queue runs once a
 * minute and stops after three failures, so without this a three-minute outage
 * stranded every gallery delivery mail until an admin retried it by hand.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mail-outage-')), 'test.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mail-outage-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mail-outage-storage-'));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('mail server outage', () => {
  let db; let cleanup; let transport; let enabled; let send;

  async function queueMail(createdAt = new Date()) {
    const inserted = await db('email_queue').insert({
      recipient_email: 'guest@example.com',
      email_type: 'gallery_created',
      email_data: JSON.stringify({ gallery_name: 'Test', subject: 'Test' }),
      status: 'pending',
      created_at: createdAt.toISOString(),
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  }

  const run = () => require('../../src/services/emailProcessor').processEmailQueue();
  const row = (id) => db('email_queue').where({ id }).first();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    process.env.EMAIL_FROM = 'noreply@example.com';
    transport = require('../../src/services/emailWebhookTransport');
    enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
    send = jest.spyOn(transport, 'send');
  }, 120000);

  afterAll(async () => {
    enabled.mockRestore();
    send.mockRestore();
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    send.mockReset();
    await db('email_queue').del();
  });

  it('defers a mail on a connection failure without spending an attempt', async () => {
    const id = await queueMail();
    send.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await run();
    const deferred = await row(id);
    expect(deferred).toMatchObject({ status: 'pending', retry_count: 0 });
    expect(deferred.error_message).toContain('ECONNREFUSED');
    expect(deferred.scheduled_at).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips a deferred mail until its time comes, then sends it', async () => {
    const id = await queueMail();
    send.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    await run();
    const { queueTimestamp, toMillis } = require('../../src/utils/queueTimestamps');
    expect(toMillis((await row(id)).scheduled_at)).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    send.mockResolvedValue({ html: '<p>ok</p>' });
    // Jest's sandbox Dates do not bind on SQLite (see adminSystemHealth.js), so
    // the processor's schedule filter can only be exercised on Postgres.
    if (db.client.config.client === 'pg') {
      await run();
      expect(send).toHaveBeenCalledTimes(1);
    }

    await db('email_queue').where({ id }).update({ scheduled_at: queueTimestamp(Date.now() - 1000) });
    await run();
    expect((await row(id)).status).toBe('sent');
  });

  it('stops the pass instead of hitting a dead server once per mail', async () => {
    await queueMail();
    await queueMail();
    send.mockRejectedValue(Object.assign(new Error('greeting never received'), { code: 'ETIMEDOUT' }));
    await run();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still spends an attempt on an error about the mail itself', async () => {
    const id = await queueMail();
    const before = await row(id);
    send.mockRejectedValue(Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }));
    await run();
    expect(await row(id)).toMatchObject({ retry_count: 1, scheduled_at: before.scheduled_at });
  });

  const status = () => require('../../src/services/emailProcessor').getQueueProcessorStatus();
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

  async function endOutage() {
    send.mockResolvedValue({ html: '<p>ok</p>' });
    await queueMail();
    await run();
    await db('email_queue').del();
  }

  it('reports the outage until a mail gets through', async () => {
    await endOutage();
    expect(status().outage).toBeNull();
    await queueMail();
    send.mockRejectedValue(refused());
    await run();
    expect(status().outage).toMatchObject({ error: 'connect ECONNREFUSED' });
    await endOutage();
    expect(status().outage).toBeNull();
  });

  it('protects a mail queued long before the outage began', async () => {
    await endOutage();
    const id = await queueMail(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    send.mockRejectedValue(refused());
    await run();
    expect((await row(id)).retry_count).toBe(0);
  });

  it('goes back to the attempt cap once an outage has lasted three days', async () => {
    await endOutage();
    await queueMail();
    send.mockRejectedValue(refused());
    await run();
    await db('email_queue').del();

    const id = await queueMail();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 4 * 24 * 60 * 60 * 1000);
    await run();
    clock.mockRestore();
    expect((await row(id)).retry_count).toBe(1);
  });

  it.each([
    ['one recipient greylisted', { code: 'EENVELOPE', responseCode: 450 }],
    ['a failure after DATA', { code: 'ETIMEDOUT', command: 'DATA' }],
  ])('spends an attempt on %s', async (_label, shape) => {
    await endOutage();
    const id = await queueMail();
    send.mockRejectedValue(Object.assign(new Error('try later'), shape));
    await run();
    expect((await row(id)).retry_count).toBe(1);
  });
});

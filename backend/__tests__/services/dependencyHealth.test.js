jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/appSettings', () => ({ getAppSetting: jest.fn(), upsertAppSetting: jest.fn() }));

const { getAppSetting, upsertAppSetting } = require('../../src/utils/appSettings');
const dependencyHealth = require('../../src/services/dependencyHealth');

const { DependencyHealth, diskState, TRIP_AFTER, DOWN_AFTER, RECOVER_AFTER } = dependencyHealth;
const GIB = 1024 ** 3;

function build(probes) {
  return new DependencyHealth({ probes });
}

async function ticks(health, count) {
  for (let i = 0; i < count; i += 1) await health.tick();
}

beforeEach(() => {
  getAppSetting.mockReset();
  getAppSetting.mockImplementation(async (_key, fallback) => fallback);
});

describe('breaker transitions', () => {
  it('ignores one bad probe', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('blip')) });
    await ticks(health, TRIP_AFTER - 1);
    expect(health.states().storage).toBe('healthy');
  });

  it('degrades, then goes down on repeated failures', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EIO')) });
    await ticks(health, TRIP_AFTER);
    expect(health.states().storage).toBe('degraded');
    await ticks(health, DOWN_AFTER - TRIP_AFTER);
    expect(health.states().storage).toBe('down');
    expect(health.snapshot().dependencies.storage.detail).toBe('EIO');
  });

  it('gives a merely slow dependency longer, and never calls it down', async () => {
    const health = build({ storage: jest.fn().mockResolvedValue({ state: 'degraded', detail: 'slow', slow: true }) });
    await ticks(health, DOWN_AFTER - 1);
    expect(health.states().storage).toBe('healthy');
    await ticks(health, 1);
    expect(health.states().storage).toBe('degraded');
    await ticks(health, DOWN_AFTER * 2);
    expect(health.states().storage).toBe('degraded');
  });

  it('does not let a bad reading improve the state', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('EIO'));
    const health = build({ storage: probe });
    await ticks(health, DOWN_AFTER);
    probe.mockResolvedValueOnce({ state: 'healthy' });
    await ticks(health, 3);
    expect(health.states().storage).toBe('down');
    probe.mockResolvedValueOnce({ state: 'degraded', detail: 'slow', slow: true });
    await ticks(health, 1);
    expect(health.states().storage).toBe('down');
  });

  it('steps down to degraded only after a stable run of better readings', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('disk full'));
    const health = build({ disk: probe });
    await ticks(health, DOWN_AFTER);
    probe.mockReset();
    probe.mockResolvedValue({ state: 'degraded' });
    await ticks(health, RECOVER_AFTER - 1);
    expect(health.states().disk).toBe('down');
    await ticks(health, 1);
    expect(health.states().disk).toBe('degraded');
  });

  it('does not stack a new probe on one that has not returned', async () => {
    const probe = jest.fn(() => new Promise(() => {}));
    const health = build({ storage: probe });
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 3; i += 1) {
        const pass = health.tick();
        await jest.advanceTimersByTimeAsync(6000);
        await pass;
      }
    } finally {
      jest.useRealTimers();
    }
    expect(probe).toHaveBeenCalledTimes(1);
    expect(health.snapshot().dependencies.storage.detail).toBe('previous check has not returned');
  });

  it('keeps checking when the settings read hangs', async () => {
    getAppSetting.mockImplementation(() => new Promise(() => {}));
    const health = build({ storage: jest.fn().mockResolvedValue({ state: 'healthy' }) });
    jest.useFakeTimers();
    try {
      const pass = health.tick();
      await jest.advanceTimersByTimeAsync(6000);
      await pass;
    } finally {
      jest.useRealTimers();
    }
    expect(health.running).toBeNull();
  });

  it('needs a stable run to recover, and a blip restarts it', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('EIO'));
    const health = build({ storage: probe });
    await ticks(health, DOWN_AFTER);
    probe.mockReset();
    probe.mockResolvedValue({ state: 'healthy' });
    await ticks(health, RECOVER_AFTER - 1);
    expect(health.states().storage).toBe('down');
    probe.mockRejectedValueOnce(new Error('EIO'));
    await ticks(health, RECOVER_AFTER - 1 + 1);
    expect(health.states().storage).toBe('down');
    await ticks(health, 1);
    expect(health.states().storage).toBe('healthy');
  });

  it('recovers at once when an admin rechecks and the probe is good', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('EIO'));
    const health = build({ storage: probe });
    await ticks(health, DOWN_AFTER);
    probe.mockReset();
    probe.mockResolvedValue({ state: 'healthy' });
    await health.recheck();
    expect(health.states().storage).toBe('healthy');
  });

  it('stays broken when a recheck still fails', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EIO')) });
    await ticks(health, DOWN_AFTER);
    await health.recheck();
    expect(health.states().storage).toBe('down');
  });

  it('leaves out a dependency that is not configured', async () => {
    const health = build({ faceSidecar: jest.fn().mockResolvedValue(null) });
    await ticks(health, 1);
    expect(health.snapshot().dependencies).toEqual({});
  });

  it('runs one pass at a time', async () => {
    let finish;
    const probe = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    const health = build({ storage: probe });
    const first = health.tick();
    const second = health.tick();
    finish({ state: 'healthy' });
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('capabilities', () => {
  it('feeds breaker state into the decision', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EIO')) });
    await ticks(health, TRIP_AFTER);
    expect(health.evaluate('uploads.new')).toMatchObject({ available: false, paused: false, blockedBy: ['storage'] });
    expect(health.evaluate('downloads.archive').available).toBe(true);
  });

  it('pauses for real only when enforcing or forced', async () => {
    const health = build({ storage: jest.fn().mockRejectedValue(new Error('EIO')) });
    await ticks(health, TRIP_AFTER);
    health.enforcement = 'enforce';
    expect(health.evaluate('uploads.new').paused).toBe(true);
    health.enforcement = 'observe';
    health.forcedOff = ['downloads.archive'];
    expect(health.evaluate('downloads.archive').paused).toBe(true);
  });

  it('drops unknown names from a stored override', async () => {
    getAppSetting.mockImplementation(async (key, fallback) => (
      key === dependencyHealth.FORCED_OFF_KEY ? ['uploads.new', 'auth.bypass'] : fallback
    ));
    const health = build({});
    await ticks(health, 1);
    expect(health.forcedOff).toEqual(['uploads.new']);
  });

  it('keeps the last settings when the database cannot be read', async () => {
    getAppSetting.mockImplementation(async (key, fallback) => (
      key === dependencyHealth.ENFORCEMENT_KEY ? 'enforce' : fallback
    ));
    const health = build({});
    await ticks(health, 1);
    getAppSetting.mockRejectedValue(new Error('db down'));
    await ticks(health, 1);
    expect(health.enforcement).toBe('enforce');
  });
});

describe('updateSettings', () => {
  it('never stores a name outside the catalog', async () => {
    const health = build({});
    await health.updateSettings({ forcedOff: ['uploads.new', 'auth.bypass'] });
    expect(upsertAppSetting).toHaveBeenCalledWith(dependencyHealth.FORCED_OFF_KEY, JSON.stringify(['uploads.new']), 'system');
  });
});

describe('diskState', () => {
  it('is relative on a small disk', () => {
    expect(diskState(3 * GIB, 20 * GIB)).toBe('healthy');
    expect(diskState(1.5 * GIB, 20 * GIB)).toBe('degraded');
    expect(diskState(0.4 * GIB, 20 * GIB)).toBe('down');
  });

  it('does not stop a large disk with plenty left', () => {
    expect(diskState(100 * GIB, 2000 * GIB)).toBe('healthy');
    expect(diskState(10 * GIB, 2000 * GIB)).toBe('degraded');
    expect(diskState(3 * GIB, 2000 * GIB)).toBe('down');
  });
});

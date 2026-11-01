import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQuery: query }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: unknown) => (typeof options === 'string' ? options : key) }),
}));
vi.mock('../../common', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: String }) }));
vi.mock('../../../services/systemHealth.service', () => ({ systemHealthService: {} }));

import { DependencyStatusCard } from '../DependencyStatusCard';

describe('DependencyStatusCard', () => {
  afterEach(cleanup);

  it('renders nothing before the first probe has reported', () => {
    query.mockReturnValue({ data: undefined });
    const { container } = render(<DependencyStatusCard />);
    expect(container.textContent).toBe('');
  });

  it('shows a failing dependency with its detail and the paused feature', () => {
    query.mockReturnValue({ data: {
      enforcement: 'enforce',
      forcedOff: [],
      dependencies: {
        storage: { state: 'down', since: '2026-11-01T10:00:00Z', detail: 'EIO', metrics: null },
        disk: { state: 'healthy', since: '2026-11-01T10:00:00Z', detail: null, metrics: { freeBytes: 2 * 1024 ** 3 } },
      },
      capabilities: [{ name: 'uploads.new', available: false, forced: false, blockedBy: ['storage'] }],
    } });
    render(<DependencyStatusCard />);
    expect(screen.getByText('EIO')).toBeTruthy();
    expect(screen.getByText('systemHealth.dependencies.state.down')).toBeTruthy();
    expect(screen.getByText('systemHealth.dependencies.unavailable')).toBeTruthy();
    expect(screen.getByText('systemHealth.dependencies.metrics.free')).toBeTruthy();
  });
});

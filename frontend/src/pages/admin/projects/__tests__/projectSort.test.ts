import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../../../../services/projects.service';
import { sortProjects } from '../projectSort';

const p = (id: number, extra: Partial<ProjectSummary>): ProjectSummary => ({
  id, name: `P${id}`, customerAccountId: null, customerEmail: null, status: 'active', createdAt: null, updatedAt: null, ...extra,
});
const value = (totalMinor: number, currency = 'CHF') => ({ byCurrency: [{ currency, totalMinor }] }) as ProjectSummary['valuation'];

const list = [
  p(1, { customerEmail: 'zora@example.com', eventCount: 2, status: 'cancelled', valuation: value(100) }),
  p(2, { customerEmail: null, eventCount: 0, status: 'inquiry' }),
  p(3, { customerEmail: 'anja@example.com', eventCount: 5, status: 'completed', valuation: value(900) }),
  p(4, { customerEmail: 'Bea@example.com', eventCount: 2, status: 'active', valuation: value(400, 'EUR') }),
];
const ids = (rows: ProjectSummary[]) => rows.map((r) => r.id);

describe('sortProjects', () => {
  it('keeps the server order without a sort', () => {
    expect(ids(sortProjects(list, 'none'))).toEqual([1, 2, 3, 4]);
  });

  it('sorts by customer, ignoring case, with no customer last both ways', () => {
    expect(ids(sortProjects(list, 'customer_asc'))).toEqual([3, 4, 1, 2]);
    expect(ids(sortProjects(list, 'customer_desc'))).toEqual([1, 4, 3, 2]);
  });

  it('sorts by number of galleries, ties in server order', () => {
    expect(ids(sortProjects(list, 'galleries_desc'))).toEqual([3, 1, 4, 2]);
    expect(ids(sortProjects(list, 'galleries_asc'))).toEqual([2, 1, 4, 3]);
  });

  it('sorts by status in lifecycle order', () => {
    expect(ids(sortProjects(list, 'status_asc'))).toEqual([2, 4, 3, 1]);
  });

  it('sorts by name, ignoring case, numbers in order', () => {
    const named = [p(1, { name: 'hochzeit 10' }), p(2, { name: 'Alpenbau' }), p(3, { name: 'Hochzeit 9' })];
    expect(ids(sortProjects(named, 'name_asc'))).toEqual([2, 3, 1]);
    expect(ids(sortProjects(named, 'name_desc'))).toEqual([1, 3, 2]);
  });

  it('sorts by last update, never-updated last both ways', () => {
    const dated = [
      p(1, { updatedAt: '2026-10-01T10:00:00Z' }), p(2, { updatedAt: null }), p(3, { updatedAt: '2026-10-21T08:00:00Z' }),
    ];
    expect(ids(sortProjects(dated, 'updated_desc'))).toEqual([3, 1, 2]);
    expect(ids(sortProjects(dated, 'updated_asc'))).toEqual([1, 3, 2]);
  });

  it('sorts by value, a project without one counting as zero', () => {
    expect(ids(sortProjects(list, 'value_desc'))).toEqual([3, 4, 1, 2]);
    expect(ids(sortProjects(list, 'value_asc'))).toEqual([2, 1, 4, 3]);
  });
});

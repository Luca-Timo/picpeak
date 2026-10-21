/**
 * Column sorting for the Projects list. The list is not paged (GET /projects
 * returns every project the admin sees), so it sorts in the browser, on the
 * same values the table shows.
 */
import type { SortColumnMap } from '../../../components/common';
import type { ProjectStatus, ProjectSummary } from '../../../services/projects.service';

export type ProjectSort =
  | 'none'
  | 'name_asc' | 'name_desc'
  | 'customer_asc' | 'customer_desc'
  | 'galleries_asc' | 'galleries_desc'
  | 'status_asc' | 'status_desc'
  | 'value_asc' | 'value_desc'
  | 'updated_asc' | 'updated_desc';

export const PROJECT_SORT_COLUMNS: SortColumnMap = {
  name: { asc: 'name_asc', desc: 'name_desc' },
  customer: { asc: 'customer_asc', desc: 'customer_desc' },
  galleries: { asc: 'galleries_asc', desc: 'galleries_desc', defaultDir: 'desc' },
  status: { asc: 'status_asc', desc: 'status_desc' },
  value: { asc: 'value_asc', desc: 'value_desc', defaultDir: 'desc' },
  updated: { asc: 'updated_asc', desc: 'updated_desc', defaultDir: 'desc' },
};

/** The order a job moves through, not the alphabet. */
const STATUS_ORDER: ProjectStatus[] = ['inquiry', 'active', 'completed', 'cancelled', 'archived'];

/** A project's value for sorting: its largest currency total. Amounts in
 *  different currencies are not added up; most installs bill in one. */
function valueOf(p: ProjectSummary): number {
  const totals = (p.valuation?.byCurrency || []).map((b) => b.totalMinor);
  return totals.length ? Math.max(...totals) : 0;
}

export function sortProjects(list: ProjectSummary[], sort: ProjectSort, locale?: string): ProjectSummary[] {
  if (sort === 'none') return list;
  const [col, dir] = sort.split('_') as [string, 'asc' | 'desc'];
  const sign = dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const cmp = (a: ProjectSummary, b: ProjectSummary): number => {
    if (col === 'name') return sign * collator.compare(a.name, b.name);
    if (col === 'updated') {
      // Never updated goes last, either way round. Compared as times.
      if (!a.updatedAt || !b.updatedAt) return (a.updatedAt ? 0 : 1) - (b.updatedAt ? 0 : 1);
      return sign * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    }
    if (col === 'customer') {
      // Projects without a customer go last, either way round.
      if (!a.customerEmail || !b.customerEmail) return (a.customerEmail ? 0 : 1) - (b.customerEmail ? 0 : 1);
      return sign * collator.compare(a.customerEmail, b.customerEmail);
    }
    if (col === 'galleries') return sign * ((a.eventCount ?? 0) - (b.eventCount ?? 0));
    if (col === 'status') {
      const rank = (s: ProjectStatus) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? STATUS_ORDER.length : i; };
      return sign * (rank(a.status) - rank(b.status));
    }
    return sign * (valueOf(a) - valueOf(b));
  };
  // Ties keep the server's order (newest first), so the sort is stable.
  return list.map((p, i) => ({ p, i })).sort((x, y) => cmp(x.p, y.p) || x.i - y.i).map(({ p }) => p);
}

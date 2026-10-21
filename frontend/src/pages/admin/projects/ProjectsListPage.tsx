/**
 * Admin → Project Overview list page.
 *
 * Lists every project (the admin-only grouping layer above events) with a
 * search box, a "New inquiry" action (NewInquiryPage), and a click-through to each
 * project's cockpit. Visual shape mirrors the other /admin/clients lists so
 * the CRM area feels like one product. Admin-only — customers never see it.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, FolderKanban } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading, SortButton, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell, useColumnSort } from '../../../components/common';
import { projectsService, type ProjectSummary } from '../../../services/projects.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { formatMoneyMinor } from '../../../utils/money';
import { SectionPageHeader } from '../../../components/admin/SectionPageHeader';
import { usePermissions } from '../../../contexts/PermissionsContext';
import { STATUS_TONE } from './ProjectCockpitPage';
import { PROJECT_SORT_COLUMNS, sortProjects, type ProjectSort } from './projectSort';

/** Render a project's rolled-up value (newest stage per deal, cumulative),
 *  one entry per currency. Convention (deliberately differs from the Events
 *  column): a zero *count* is a real number → "0"; a zero *value* means "nothing
 *  billed/quoted yet" → em dash, since "CHF 0.00" would wrongly imply a real
 *  zero-value deal. */
function formatValuation(p: ProjectSummary): string {
  const buckets = p.valuation?.byCurrency?.filter((b) => b.totalMinor !== 0) || [];
  if (buckets.length === 0) return '—';
  return buckets.map((b) => formatMoneyMinor(b.totalMinor, b.currency)).join(' · ');
}

export const ProjectsListPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const { format } = useLocalizedDate();
  const [search, setSearch] = useState('');

  const { data: projects, isLoading, isError, isRefetching, refetch } = useQuery({
    queryKey: ['projects', { search }],
    queryFn: () => projectsService.list({ q: search || undefined }),
  });
  const { sort, activeKey, activeDir, toggle } = useColumnSort<ProjectSort>(PROJECT_SORT_COLUMNS, 'none');
  const rows = useMemo(() => sortProjects(projects || [], sort, i18n.language), [projects, sort, i18n.language]);
  const ariaSort = (key: string) => (activeKey === key ? (activeDir === 'asc' ? 'ascending' : 'descending') : undefined);

  return (
    <div>
      <SectionPageHeader
        feature="projects"
        icon={FolderKanban}
        title={t('projects.title', 'Projects')}
        description={t('projects.subtitle', 'Group galleries into projects and see every email, document and hour in one cockpit.')}
        actions={hasPermission('events.edit') ? (
          <Button variant="primary" leftIcon={<Plus className="w-4 h-4" />} onClick={() => navigate('/admin/clients/projects/new')}>
            {t('projects.inquiry.title', 'New inquiry')}
          </Button>
        ) : undefined}
      />

      {/* Search */}
      <div className="relative mb-3 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('projects.search', 'Search by name or customer…') as string}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : isError && !projects ? (
        <Card>
          <ErrorState
            size="inline"
            title={t('projects.loadFailed', 'Could not load the projects')}
            onRetry={() => refetch()}
            retrying={isRefetching}
          />
        </Card>
      ) : !projects || projects.length === 0 ? (
        <Card>
          <EmptyState
            size="inline"
            icon={<FolderKanban />}
            title={search
              ? t('projects.noMatches', 'No projects match this search')
              : t('projects.emptyTitle', 'No projects yet')}
            description={search ? undefined : t('projects.empty', 'Start one with New inquiry, or galleries you already have were grouped automatically.')}
          />
        </Card>
      ) : (
        <Table>
          <TableHead>
            <tr>
              <TableHeaderCell aria-sort={ariaSort('name')}><SortButton label={t('projects.col.name', 'Project')} columnKey="name" activeKey={activeKey} activeDir={activeDir} onSort={toggle} className="uppercase tracking-wide" /></TableHeaderCell>
              <TableHeaderCell aria-sort={ariaSort('customer')}><SortButton label={t('projects.col.customer', 'Customer')} columnKey="customer" activeKey={activeKey} activeDir={activeDir} onSort={toggle} className="uppercase tracking-wide" /></TableHeaderCell>
              <TableHeaderCell align="right" aria-sort={ariaSort('galleries')}><SortButton label={t('projects.col.events', 'Galleries')} columnKey="galleries" activeKey={activeKey} activeDir={activeDir} onSort={toggle} className="uppercase tracking-wide" align="right" /></TableHeaderCell>
              <TableHeaderCell align="right" aria-sort={ariaSort('value')}><SortButton label={t('projects.col.value', 'Value')} columnKey="value" activeKey={activeKey} activeDir={activeDir} onSort={toggle} className="uppercase tracking-wide" align="right" /></TableHeaderCell>
              <TableHeaderCell aria-sort={ariaSort('status')}><SortButton label={t('projects.col.status', 'Status')} columnKey="status" activeKey={activeKey} activeDir={activeDir} onSort={toggle} className="uppercase tracking-wide" /></TableHeaderCell>
              <TableHeaderCell aria-sort={ariaSort('updated')}><SortButton label={t('projects.col.updated', 'Updated')} columnKey="updated" activeKey={activeKey} activeDir={activeDir} onSort={toggle} className="uppercase tracking-wide" /></TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {rows.map((p: ProjectSummary) => (
              <TableRow
                key={p.id}
                interactive
                onClick={() => navigate(`/admin/clients/projects/${p.id}`)}
              >
                <TableCell className="font-medium text-heading">{p.name}</TableCell>
                <TableCell className="text-soft">{p.customerEmail || '—'}</TableCell>
                <TableCell align="right">{p.eventCount ?? 0}</TableCell>
                <TableCell align="right" className="font-medium text-heading">{formatValuation(p)}</TableCell>
                <TableCell>
                  <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{t(`projects.status.${p.status}`, p.status)}</Badge>
                </TableCell>
                <TableCell className="text-muted">{p.updatedAt ? format(p.updatedAt) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
};

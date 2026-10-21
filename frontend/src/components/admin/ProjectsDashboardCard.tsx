/**
 * Dashboard card: the open projects (inquiries and projects in progress),
 * counted by the stage they are at, then listed with their next step. A
 * stage tile filters the list. Renders nothing with the `projects` feature
 * off or without `events.view` (GET /admin/projects); each row opens its
 * project page.
 */
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FolderKanban, Inbox } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, SkeletonList } from '../common';
import { projectsService, type ProjectStageKey, type ProjectSummary } from '../../services/projects.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';

const PIPELINE: ProjectStageKey[] = ['quote', 'contract', 'gallery', 'invoice', 'done'];
const MAX_ROWS = 6;

export const ProjectsDashboardCard: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { format } = useLocalizedDate();
  const { flags } = useFeatureFlags();
  const { hasPermission } = usePermissions();
  const enabled = !!flags.clients && !!flags.projects && hasPermission('events.view');
  const [stage, setStage] = useState<ProjectStageKey | null>(null);

  const { data: projects = [], isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['projects', 'dashboard'],
    queryFn: () => projectsService.list({ status: 'inquiry,active', withStages: true }),
    enabled,
  });

  const counts = useMemo(() => {
    const out = new Map<ProjectStageKey, number>();
    for (const p of projects) {
      const key = p.stage?.current;
      if (key) out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  }, [projects]);

  if (!enabled) return null;

  const rows = projects.filter((p) => !stage || p.stage?.current === stage).slice(0, MAX_ROWS);
  const meta = (p: ProjectSummary) => [p.customerEmail, p.eventDate ? format(p.eventDate) : null, p.location]
    .filter(Boolean).join(' · ');

  return (
    <Card padding="md" className="mb-8">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-heading">
          <FolderKanban className="w-5 h-5" />{t('projects.dashboard.title', 'Projects')}
        </h2>
        <button type="button" onClick={() => navigate('/admin/clients/projects')} className="text-sm font-medium text-accent hover:underline">
          {t('projects.dashboard.all', 'All projects')} →
        </button>
      </div>

      {isLoading ? (
        <SkeletonList count={3} />
      ) : isError ? (
        <ErrorState size="inline" title={t('projects.loadFailed', 'Could not load the projects')} onRetry={() => refetch()} retrying={isRefetching} />
      ) : projects.length === 0 ? (
        <EmptyState
          size="inline"
          title={t('projects.dashboard.empty', 'No open projects. A new inquiry starts one.')}
          action={hasPermission('events.edit') ? (
            <Button variant="outline" size="sm" leftIcon={<Inbox className="w-4 h-4" />} onClick={() => navigate('/admin/clients/projects/new')}>
              {t('projects.inquiry.title', 'New inquiry')}
            </Button>
          ) : undefined}
        />
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-4" role="group" aria-label={t('projects.dashboard.byStage', 'By stage') as string}>
            {PIPELINE.map((key) => {
              const on = stage === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setStage(on ? null : key)}
                  className={`rounded-xl border px-3 py-2 text-left ${on ? 'border-accent-soft bg-accent-soft text-on-accent-soft' : 'border-line bg-subtle hover:bg-hover-soft'}`}
                >
                  <span className={`block text-xl font-bold ${on ? '' : 'text-heading'}`}>{counts.get(key) || 0}</span>
                  <span className={`block text-sm ${on ? '' : 'text-muted'}`}>{t(`projects.stage.${key}`)}</span>
                </button>
              );
            })}
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-muted py-3">{t('projects.dashboard.noneAtStage', 'No project at this stage.')}</p>
          ) : (
            <ul className="divide-y divide-line-faint border-t border-line-faint">
              {rows.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/admin/clients/projects/${p.id}`)}
                    className="w-full grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-x-4 gap-y-1 items-center px-1 py-3 text-left hover:bg-hover-soft"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-heading truncate">{p.name}</span>
                      {meta(p) && <span className="block text-xs text-muted truncate">{meta(p)}</span>}
                    </span>
                    <span className="order-3 sm:order-none col-span-2 sm:col-span-1 inline-flex items-center gap-1.5 text-sm text-body">
                      {p.stage?.current && (
                        <>
                          <ArrowRight className="w-4 h-4 text-accent" />
                          {t('projects.dashboard.next', 'Next: {{stage}}', { stage: t(`projects.stage.${p.stage.current}`) })}
                        </>
                      )}
                    </span>
                    <Badge tone={p.status === 'inquiry' ? 'info' : 'success'}>{t(`projects.status.${p.status}`, p.status)}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
};

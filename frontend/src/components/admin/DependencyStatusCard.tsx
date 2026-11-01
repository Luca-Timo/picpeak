import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { Button, Card } from '../common';
import { useMutationWithToast } from '../../hooks';
import { usePermission } from '../../hooks/usePermission';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import {
  systemHealthService,
  type DependencyState,
  type DegradationStatus,
  type DependencyStatus,
} from '../../services/systemHealth.service';

const GB = 1024 ** 3;

const STATE_ICONS: Record<DependencyState, React.ReactNode> = {
  healthy: <CheckCircle className="w-4 h-4 text-success-text shrink-0" />,
  degraded: <AlertCircle className="w-4 h-4 text-warning-text shrink-0" />,
  down: <XCircle className="w-4 h-4 text-danger-text shrink-0" />,
};

/**
 * The live readings worth showing next to a dependency. Only numbers the probe
 * actually reported: a value it could not read stays out rather than showing 0.
 */
function useMetricLabels() {
  const { t } = useTranslation();
  return (metrics: DependencyStatus['metrics']): string[] => {
    if (!metrics) return [];
    const labels: string[] = [];
    const add = (value: number | null | undefined, key: string, format = (n: number) => String(Math.round(n))) => {
      if (typeof value === 'number') labels.push(t(`systemHealth.dependencies.metrics.${key}`, { value: format(value) }));
    };
    add(metrics.cpuPercent, 'cpu');
    add(metrics.memoryPercent, 'memory');
    add(metrics.eventLoopDelayMs, 'eventLoop');
    add(metrics.freeBytes, 'free', (bytes) => (bytes / GB).toFixed(1));
    add(metrics.pendingPhotos, 'pending');
    return labels;
  };
}

/**
 * Mounted only with status data, so the page's other panels do not depend on
 * the permission context. Forcing a feature off is all an admin can do here:
 * nothing on this panel can turn on what a failed dependency switched off.
 */
const DegradationControls: React.FC<{ status: DegradationStatus }> = ({ status }) => {
  const { t } = useTranslation();
  const canManage = usePermission('system.manage');
  const invalidateKeys = [['system-health-status']];

  const recheck = useMutationWithToast({
    mutationFn: () => systemHealthService.recheckStatus(),
    invalidateKeys,
    successMessage: t('systemHealth.dependencies.recheckedToast'),
    errorMessage: () => t('toast.saveError'),
  });
  const save = useMutationWithToast({
    mutationFn: systemHealthService.updateDegradationSettings,
    invalidateKeys,
    successMessage: t('toast.settingsSaved', 'Settings saved'),
    errorMessage: () => t('toast.saveError'),
  });

  if (!canManage) return null;
  const enforcing = status.enforcement === 'enforce';

  return (
    <div className="mt-4 pt-4 border-t border-line space-y-3">
      <label className="flex items-start gap-2 text-sm text-body">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enforcing}
          disabled={save.isPending}
          onChange={() => save.mutate({ enforcement: enforcing ? 'observe' : 'enforce' })}
        />
        <span>
          {t('systemHealth.dependencies.enforce')}
          <span className="block text-xs text-muted">{t('systemHealth.dependencies.enforceHint')}</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {status.capabilities.map(({ name, forced }) => (
          <label key={name} className="flex items-center gap-2 text-sm text-body">
            <input
              type="checkbox"
              checked={forced}
              disabled={save.isPending}
              onChange={() => save.mutate({
                forcedOff: forced ? status.forcedOff.filter((other) => other !== name) : [...status.forcedOff, name],
              })}
            />
            {t('systemHealth.dependencies.forceOff', { capability: t(`systemHealth.dependencies.capability.${name}`, name) })}
          </label>
        ))}
      </div>
      <Button variant="secondary" size="sm" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
        {t('systemHealth.dependencies.recheck')}
      </Button>
    </div>
  );
};

export const DependencyStatusCard: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const metricLabels = useMetricLabels();

  const { data } = useQuery({
    queryKey: ['system-health-status'],
    queryFn: () => systemHealthService.getStatus(),
    refetchInterval: 15000,
  });

  const dependencies = Object.entries(data?.dependencies ?? {});
  if (dependencies.length === 0) return null;

  return (
    <Card padding="lg" className="mb-4">
      <div className="flex items-center gap-2 mb-1">
        <Activity className="w-5 h-5 text-muted" />
        <h2 className="text-lg font-semibold text-heading">{t('systemHealth.dependencies.title')}</h2>
      </div>
      <p className="text-sm text-soft mb-3">{t('systemHealth.dependencies.description')}</p>

      <ul className="divide-y divide-line">
        {dependencies.map(([name, dependency]) => {
          const metrics = metricLabels(dependency.metrics);
          return (
            <li key={name} className="py-2">
              <div className="flex items-center gap-2 text-sm">
                {STATE_ICONS[dependency.state]}
                <span className="font-medium text-heading">{t(`systemHealth.dependencies.name.${name}`, name)}</span>
                <span className="text-muted">{t(`systemHealth.dependencies.state.${dependency.state}`)}</span>
                {dependency.state !== 'healthy' && (
                  <span className="text-xs text-muted">
                    {t('systemHealth.dependencies.since', { time: formatDateTime(dependency.since) })}
                  </span>
                )}
              </div>
              {metrics.length > 0 && <p className="ml-6 text-xs text-muted">{metrics.join(' · ')}</p>}
              {dependency.detail && <p className="ml-6 text-xs text-danger-text break-words">{dependency.detail}</p>}
            </li>
          );
        })}
      </ul>

      <h3 className="text-sm font-semibold text-heading mt-4 mb-2">{t('systemHealth.dependencies.capabilitiesTitle')}</h3>
      <ul className="space-y-1">
        {(data?.capabilities ?? []).map((capability) => (
          <li key={capability.name} className="flex items-center gap-2 text-sm">
            {capability.available ? STATE_ICONS.healthy : STATE_ICONS.degraded}
            <span className="text-body">{t(`systemHealth.dependencies.capability.${capability.name}`, capability.name)}</span>
            <span className="text-muted">
              {capability.available ? t('systemHealth.dependencies.available') : t('systemHealth.dependencies.unavailable')}
            </span>
          </li>
        ))}
      </ul>

      {data && <DegradationControls status={data} />}
    </Card>
  );
};

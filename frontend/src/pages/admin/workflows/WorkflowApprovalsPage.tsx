/**
 * Admin → Workflows → Approvals inbox. Lists workflow runs paused on a gate
 * (e.g. "confirm there's no payment") and lets the admin confirm or deny,
 * resuming the run down the matching edge. The same decision is also possible
 * from the emailed confirm/deny link.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Check, X } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { workflowsService, type WorkflowApproval } from '../../../services/workflows.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

export const WorkflowApprovalsPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { formatDateTime } = useLocalizedDate();

  const { data: approvals, isLoading } = useQuery({
    queryKey: ['workflow-approvals'],
    queryFn: () => workflowsService.approvals(),
  });

  const actMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'confirm' | 'deny' }) => workflowsService.actApproval(id, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-approvals'] });
      toast.success(t('workflows.approvals.recorded', 'Response recorded') as string);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('common.error', 'Something went wrong') as string)),
  });

  const promptOf = (a: WorkflowApproval) => (a.payload && (a.payload.prompt as string)) || t('workflows.approvals.defaultPrompt', 'A workflow needs your confirmation.');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/admin/workflows')} aria-label={t('common.back', 'Back') as string}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('workflows.approvals.title', 'Approvals')}</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('workflows.approvals.subtitle', 'Workflow runs waiting on your confirmation.')}</p>
        </div>
      </div>

      <Card padding="none">
        {isLoading ? (
          <div className="p-10"><Loading /></div>
        ) : !approvals || approvals.length === 0 ? (
          <div className="p-10 text-center text-neutral-500 dark:text-neutral-400">{t('workflows.approvals.empty', 'Nothing waiting for you right now.')}</div>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
            {approvals.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-900 dark:text-neutral-100">{promptOf(a)}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                    {a.workflow_name}
                    {a.entity_type ? ` · ${a.entity_type} #${a.entity_id}` : ''}
                    {a.created_at ? ` · ${formatDateTime(a.created_at)}` : ''}
                  </div>
                </div>
                <Button variant="outline" size="sm" isLoading={actMutation.isPending} onClick={() => actMutation.mutate({ id: a.id, action: 'confirm' })} leftIcon={<Check className="w-4 h-4" />}>
                  {t('workflows.approvals.confirm', 'Confirm')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => actMutation.mutate({ id: a.id, action: 'deny' })} leftIcon={<X className="w-4 h-4" />}>
                  {t('workflows.approvals.deny', 'Deny')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};

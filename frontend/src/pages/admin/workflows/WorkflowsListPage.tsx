/**
 * Admin → Workflows list. Shows every automation flow with its trigger and
 * enabled state, a quick enable toggle, edit (canvas) and delete. "New
 * workflow" mints a minimal trigger→action graph and opens the editor. A
 * pending-approvals shortcut sits in the header.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Workflow as WorkflowIcon, Inbox, Trash2, Pencil } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { workflowsService, type WorkflowSummary, type WorkflowSavePayload } from '../../../services/workflows.service';

const NEW_WORKFLOW: WorkflowSavePayload = {
  name: 'New workflow',
  trigger_type: 'invoice.sent',
  enabled: false,
  nodes: [
    { node_key: 'trigger', type: 'trigger', pos_x: 240, pos_y: 40 },
    { node_key: 'step1', type: 'action', config: { action: 'noop' }, pos_x: 240, pos_y: 200 },
  ],
  edges: [{ from_node: 'trigger', to_node: 'step1' }],
};

export const WorkflowsListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: workflows, isLoading } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => workflowsService.list(),
  });

  const createMutation = useMutation({
    mutationFn: () => workflowsService.create(NEW_WORKFLOW),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/admin/workflows/${res.id}`);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('workflows.toast.createFailed', 'Could not create workflow') as string)),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => workflowsService.setEnabled(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('common.error', 'Something went wrong') as string)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => workflowsService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(t('workflows.toast.deleted', 'Workflow deleted') as string);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('workflows.toast.deleteFailed', 'Could not delete workflow') as string)),
  });

  const isEnabled = (w: WorkflowSummary) => w.enabled === true || w.enabled === 1;
  const isBuiltin = (w: WorkflowSummary) => w.is_builtin === true || w.is_builtin === 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent-soft text-on-accent-soft flex items-center justify-center">
            <WorkflowIcon className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('workflows.title', 'Workflows')}</h1>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('workflows.subtitle', 'Visual automations — triggers, conditions, gates and actions.')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate('/admin/workflows/approvals')} leftIcon={<Inbox className="w-4 h-4" />}>
            {t('workflows.approvals.title', 'Approvals')}
          </Button>
          <Button variant="primary" isLoading={createMutation.isPending} onClick={() => createMutation.mutate()} leftIcon={<Plus className="w-4 h-4" />}>
            {t('workflows.new', 'New workflow')}
          </Button>
        </div>
      </div>

      <Card padding="none">
        {isLoading ? (
          <div className="p-10"><Loading /></div>
        ) : !workflows || workflows.length === 0 ? (
          <div className="p-10 text-center text-neutral-500 dark:text-neutral-400">{t('workflows.empty', 'No workflows yet. Create one to automate your invoicing and booking steps.')}</div>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
            {workflows.map((w) => (
              <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link to={`/admin/workflows/${w.id}`} className="font-medium text-neutral-900 dark:text-neutral-100 truncate hover:underline">{w.name}</Link>
                    {isBuiltin(w) && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300">{t('workflows.builtin', 'built-in')}</span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                    {t('workflows.triggerLabel', 'Trigger')}: <code>{w.trigger_type}</code> · v{w.version}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => toggleMutation.mutate({ id: w.id, enabled: !isEnabled(w) })}
                  className={`text-xs px-2 py-1 rounded-full border ${isEnabled(w)
                    ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700'
                    : 'bg-neutral-50 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 border-neutral-300 dark:border-neutral-600'}`}
                >
                  {isEnabled(w) ? t('workflows.enabled', 'Enabled') : t('workflows.disabled', 'Disabled')}
                </button>
                <Button variant="ghost" size="sm" onClick={() => navigate(`/admin/workflows/${w.id}`)} aria-label={t('common.edit', 'Edit') as string}>
                  <Pencil className="w-4 h-4" />
                </Button>
                {!isBuiltin(w) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { if (window.confirm(t('workflows.confirmDelete', 'Delete this workflow?') as string)) deleteMutation.mutate(w.id); }}
                    aria-label={t('common.delete', 'Delete') as string}
                  >
                    <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};

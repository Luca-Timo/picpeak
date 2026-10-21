/**
 * The project's Settings tab: only what is not project data (that is edited
 * on the Overview). Two sections in one column, too few for a split view:
 * Status (cancel, complete, reopen) and the Danger-Zone (delete). All are
 * actions with their own buttons and toasts; nothing here goes through the
 * save bar (UX.md › Settings vs actions).
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Ban, CheckCircle2, Flag, RotateCcw, Trash2 } from 'lucide-react';
import { Button, Card, useConfirm } from '../../../components/common';
import { useMutationWithToast } from '../../../hooks';
import { useLeaveGuard } from '../../../contexts/UnsavedChangesContext';
import { projectsService, type ProjectOverview, type ProjectStatus } from '../../../services/projects.service';

interface Props {
  data: ProjectOverview;
  canEdit: boolean;
}

/** Why the server refused the delete, by its code; it names what to move
 *  out or which permission is missing. */
function deleteRefusal(error: unknown, t: TFunction): string {
  const data = (error as { response?: { data?: { code?: string; error?: string; permissions?: string[] } } })?.response?.data;
  switch (data?.code) {
    case 'PROJECT_DELETE_NEEDS_PERMISSION':
      return t('projects.toast.deleteNeedsPermission', 'This project holds {{records}} you may not change, so you cannot delete it.', {
        records: (data.permissions || []).map((perm) => t(`projects.delete.records.${perm.replace(/\./g, '_')}`, perm)).join(', '),
      });
    case 'PROJECT_DELETE_FOREIGN_DOCUMENTS':
      return t('projects.toast.deleteForeignDocuments', 'This project holds documents of another admin. Move them out of the project first.');
    case 'PROJECT_CHANGED':
      return t('projects.toast.deleteChanged', 'Something was added to the project meanwhile. Check it and delete again.');
    case 'PROJECT_DELETE_FOREIGN_GALLERIES':
      return t('projects.toast.deleteForeignGalleries', 'This project holds galleries of another admin. Move them out of the project first.');
    default:
      // Any other refusal: the server's own words, as before.
      return data?.error || t('projects.toast.deleteFailed', 'Could not delete the project');
  }
}

const ActionRow: React.FC<{ title: string; text: string; danger?: boolean; children: React.ReactNode }> = ({ title, text, danger, children }) => (
  <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${danger ? 'border-danger-line' : 'border-line'}`}>
    <div className="min-w-0 flex-1 basis-64">
      <div className="text-sm font-semibold text-heading">{title}</div>
      <div className="text-sm text-muted">{text}</div>
    </div>
    {children}
  </div>
);

export const ProjectSettingsTab: React.FC<Props> = ({ data, canEdit }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { unguarded } = useLeaveGuard();
  const id = data.project.id;
  const status = data.project.status;
  const closed = status === 'cancelled' || status === 'completed';

  const setStatus = useMutationWithToast({
    mutationFn: (next: ProjectStatus | 'reopen') => projectsService.update(id, { status: next }),
    successMessage: (_r, next) => (next === 'cancelled'
      ? t('projects.toast.cancelled', 'Project marked as cancelled.')
      : next === 'completed'
        ? t('projects.toast.completed', 'Project completed.')
        : t('projects.toast.reopened', 'Project reopened.')) as string,
    errorMessage: t('projects.toast.saveFailed', 'Save failed') as string,
    invalidateKeys: [['project-overview', id], ['projects']],
  });

  const remove = useMutationWithToast({
    mutationFn: () => projectsService.remove(id),
    successMessage: t('projects.toast.deleted', 'Project deleted. Its galleries and documents are kept.') as string,
    errorMessage: (error) => deleteRefusal(error, t),
    invalidateKeys: [['projects']],
    // The project is gone, so its unsaved draft goes with it: no leave prompt.
    onSuccess: () => unguarded(() => navigate('/admin/clients/projects')),
  });

  const onDelete = async () => {
    const ok = await confirm({
      title: t('projects.delete.title', 'Delete project?'),
      message: t('projects.delete.confirm', 'Delete “{{name}}”? Its galleries, quotes, contracts and invoices are kept and only lose the link. The project data and notes are lost. This cannot be undone.', { name: data.project.name }),
      confirmLabel: t('projects.delete.button', 'Delete project'),
      variant: 'danger',
    });
    if (ok) remove.mutate();
  };

  if (!canEdit) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-muted">{t('projects.settings.readOnly', 'You can see this project but not change it.')}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <h2 className="flex items-center gap-2 text-base font-semibold text-heading">
          <Flag className="w-5 h-5" />{t('projects.settings.statusTitle', 'Status')}
        </h2>
        <p className="text-sm text-muted mt-1 mb-4">
          {t('projects.settings.statusHelp', 'The stage follows the quote, contract and invoices. Change the status by hand only when no job comes of it or you finish early.')}
        </p>
        <div className="space-y-2">
          {closed ? (
            <ActionRow
              title={t('projects.settings.reopenTitle', 'Reopen')}
              text={status === 'cancelled'
                ? t('projects.settings.reopenCancelled', 'This project is cancelled. Reopen it to show it on the dashboard again.')
                : t('projects.settings.reopenCompleted', 'This project is completed. Reopen it to keep working on it.')}
            >
              <Button variant="outline" size="sm" leftIcon={<RotateCcw className="w-4 h-4" />} isLoading={setStatus.isPending}
                onClick={() => setStatus.mutate('reopen')}>
                {t('projects.settings.reopen', 'Reopen')}
              </Button>
            </ActionRow>
          ) : (
            <>
              <ActionRow
                title={t('projects.settings.cancelTitle', 'Mark as cancelled')}
                text={t('projects.settings.cancelHelp', 'No job comes of it? The project leaves the dashboard but stays in the project list under “Cancelled”. Undo with Reopen.')}
              >
                <Button variant="outline" size="sm" leftIcon={<Ban className="w-4 h-4" />} isLoading={setStatus.isPending}
                  onClick={() => setStatus.mutate('cancelled')}>
                  {t('projects.settings.cancel', 'Mark as cancelled')}
                </Button>
              </ActionRow>
              <ActionRow
                title={t('projects.settings.completeTitle', 'Complete')}
                text={t('projects.settings.completeHelp', 'For a project with nothing left open, even when a stage was skipped.')}
              >
                <Button variant="outline" size="sm" leftIcon={<CheckCircle2 className="w-4 h-4" />} isLoading={setStatus.isPending}
                  onClick={() => setStatus.mutate('completed')}>
                  {t('projects.settings.complete', 'Complete')}
                </Button>
              </ActionRow>
            </>
          )}
        </div>
      </Card>

      <Card className="border-danger-line">
        <h2 className="flex items-center gap-2 text-base font-semibold text-danger-text">
          <Trash2 className="w-5 h-5" />{t('projects.settings.dangerTitle', 'Danger zone')}
        </h2>
        <p className="text-sm text-muted mt-1 mb-4">
          {t('projects.settings.dangerHelp', 'Galleries, quotes, contracts and invoices are kept and only lose the link to the project.')}
        </p>
        <ActionRow
          danger
          title={t('projects.delete.button', 'Delete project')}
          text={t('projects.settings.deleteHelp', 'Cannot be undone. The project data and notes are lost.')}
        >
          <Button variant="danger" size="sm" leftIcon={<Trash2 className="w-4 h-4" />} isLoading={remove.isPending} onClick={onDelete}>
            {t('projects.delete.button', 'Delete project')}
          </Button>
        </ActionRow>
      </Card>
    </div>
  );
};

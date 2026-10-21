/**
 * The project Overview's right column: what the project is worth, its data
 * and its customer. Data and customer are always editable fields; they change
 * the page's draft and save through its one save bar (UX.md › Saving). This
 * is a deliberate step away from "Overview holds nothing that needs saving":
 * a project's data is what it is, not configuration (see the PR body).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { Button, Card } from '../../../components/common';
import { CustomerPicker } from '../../../components/admin/CustomerPicker';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { useMutationWithToast } from '../../../hooks';
import type { ProjectValuation } from '../../../services/projects.service';
import { formatMoneyMinor } from '../../../utils/money';
import { FlowField, FrameFields, OccasionFields } from './ProjectInquiryFields';
import type { ProjectDraft, ProjectDraftKey } from './projectDraft';

export const ProjectValueCard: React.FC<{ valuation?: ProjectValuation; quotedMinor: Record<string, number> }> = ({ valuation, quotedMinor }) => {
  const { t } = useTranslation();
  const buckets = valuation?.byCurrency?.filter((b) => b.totalMinor !== 0 || b.paidMinor !== 0) || [];
  if (!buckets.length) return null;
  return (
    <Card>
      <h2 className="text-base font-semibold text-heading mb-3">{t('projects.value.label', 'Project value')}</h2>
      {buckets.map((b) => {
        const share = b.totalMinor > 0 ? Math.min(100, Math.round((b.paidMinor / b.totalMinor) * 100)) : 0;
        return (
          <div key={b.currency} className="mb-3 last:mb-0">
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
              {quotedMinor[b.currency] != null && (
                <>
                  <dt className="text-muted">{t('projects.value.quoted', 'Quoted')}</dt>
                  <dd className="text-right font-semibold text-heading tabular-nums">{formatMoneyMinor(quotedMinor[b.currency], b.currency)}</dd>
                </>
              )}
              <dt className="text-muted">{t('projects.value.total', 'Value')}</dt>
              <dd className="text-right font-semibold text-heading tabular-nums">{formatMoneyMinor(b.totalMinor, b.currency)}</dd>
              <dt className="text-muted">{t('projects.value.paidLabel', 'Paid')}</dt>
              <dd className="text-right font-semibold text-heading tabular-nums">{formatMoneyMinor(b.paidMinor, b.currency)}</dd>
            </dl>
            <div className="h-1.5 rounded-full bg-fill overflow-hidden mt-3 mb-1" aria-hidden>
              <div className="h-full bg-success" style={{ width: `${share}%` }} />
            </div>
            <p className="text-xs text-muted">
              {t('projects.value.paidShare', '{{share}} % paid · {{open}} open', {
                share, open: formatMoneyMinor(Math.max(0, b.totalMinor - b.paidMinor), b.currency),
              })}
            </p>
          </div>
        );
      })}
    </Card>
  );
};

export const ProjectDataCard: React.FC<{
  draft: ProjectDraft;
  onChange: (patch: Partial<ProjectDraft>) => void;
  dirty: ProjectDraftKey[];
  canEdit: boolean;
  defaultCurrency?: string;
}> = ({ draft, onChange, dirty, canEdit, defaultCurrency }) => {
  const { t } = useTranslation();
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h2 className="text-base font-semibold text-heading">{t('projects.data.title', 'Project data')}</h2>
        {dirty.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning-text">
            <span className="w-2 h-2 rounded-full bg-warning" aria-hidden />
            {t('projects.data.notSaved', 'not saved yet')}
          </span>
        )}
      </div>
      <p className="text-xs text-muted mb-4">
        {t('projects.data.help', 'New quotes, contracts and galleries take these values. Documents already made stay as they are.')}
      </p>
      {!canEdit && (
        <p className="text-xs text-muted mb-3">{t('projects.data.readOnly', 'You can see this data but not change it.')}</p>
      )}
      <fieldset disabled={!canEdit} className="space-y-4">
        <FlowField draft={draft} onChange={onChange} dirty={dirty} disabled={!canEdit} layout="card" />
        <OccasionFields draft={draft} onChange={onChange} dirty={dirty} disabled={!canEdit} layout="card" />
        <FrameFields draft={draft} onChange={onChange} dirty={dirty} disabled={!canEdit} defaultCurrency={defaultCurrency} layout="card" />
      </fieldset>
    </Card>
  );
};

export interface CustomerChoice {
  id: number | null;
  label: string;
  isPassive: boolean;
  /** What a suggested project name uses: the last name, else the company. */
  nameHint?: string;
}

export const ProjectCustomerCard: React.FC<{
  customer: CustomerChoice;
  savedCustomerId: number | null;
  onChange: (c: CustomerChoice) => void;
  dirty: boolean;
  canChange: boolean;
  canViewCustomers: boolean;
  canInvite: boolean;
}> = ({ customer, savedCustomerId, onChange, dirty, canChange, canViewCustomers, canInvite }) => {
  const { t } = useTranslation();
  const { data: detail } = useQuery({
    queryKey: ['admin-customer', savedCustomerId],
    queryFn: () => customerAdminService.get(savedCustomerId as number),
    enabled: !!savedCustomerId && canViewCustomers,
  });
  const invite = useMutationWithToast({
    mutationFn: () => customerAdminService.sendInvite(savedCustomerId as number),
    successMessage: (r) => t('projects.customer.invited', 'Invitation queued to {{email}}.', { email: r.email }) as string,
    errorMessage: t('projects.customer.inviteFailed', 'Could not send the invitation') as string,
    invalidateKeys: [['admin-customer', savedCustomerId]],
  });
  // The saved customer's own state and name, once loaded; the draft's while changing.
  const saved = customer.id === savedCustomerId && detail ? detail : null;
  const passive = saved ? Boolean(saved.isPassive) : customer.isPassive;
  const label = saved ? (saved.companyName || saved.displayName || saved.email) : customer.label;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-base font-semibold text-heading">{t('projects.customer.title', 'Customer')}</h2>
        {savedCustomerId && canViewCustomers && !dirty && (
          <Link to={`/admin/clients/accounts/${savedCustomerId}`} className="text-sm font-medium text-accent hover:underline">
            {t('projects.customer.open', 'Open account')}
          </Link>
        )}
      </div>
      {canViewCustomers ? (
        <CustomerPicker
          value={customer.id}
          label={label}
          isPassive={passive}
          readOnly={!canChange}
          onSelect={(c) => onChange({ id: c.id, label: c.companyName || c.displayName || c.email, isPassive: Boolean(c.isPassive) })}
          onCreate={(c) => onChange({ id: c.id, label: c.companyName || c.displayName || c.email, isPassive: Boolean(c.isPassive) })}
          onClear={() => onChange({ id: null, label: '', isPassive: false })}
        />
      ) : (
        // Without customers.view the API leaves the customer out altogether.
        <p className="text-sm text-muted">{t('projects.customer.hidden', 'Customers are not visible to your role.')}</p>
      )}
      {saved?.email && saved.email !== label && (
        <p className="text-xs text-muted mt-2">{saved.email}</p>
      )}
      {passive && canInvite && customer.id === savedCustomerId && savedCustomerId && (
        <div className="mt-3">
          <Button variant="outline" size="sm" leftIcon={<Mail className="w-4 h-4" />} isLoading={invite.isPending} onClick={() => invite.mutate()}>
            {t('projects.customer.invite', 'Invite to the portal')}
          </Button>
        </div>
      )}
    </Card>
  );
};

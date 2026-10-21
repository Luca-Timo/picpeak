/**
 * Admin → CRM → New inquiry ("Neue Anfrage"): what the customer asked for,
 * captured first. Saving creates a project with status `inquiry`; the quote,
 * contract, gallery and invoice made from it later take its data.
 *
 * An editor page (UX.md › Page anatomy): one column up to max-w-3xl, a named
 * Cancel back to the project list, and a leave guard while something is
 * typed. Only the name and the customer are needed; everything else can be
 * filled in later on the project's Overview.
 */
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, Inbox, Route, User, Wallet } from 'lucide-react';
import { Button, Card, Input } from '../../../components/common';
import { SectionPageHeader } from '../../../components/admin/SectionPageHeader';
import { CustomerPicker } from '../../../components/admin/CustomerPicker';
import { projectsService } from '../../../services/projects.service';
import { eventTypesService } from '../../../services/eventTypes.service';
import { businessProfileService } from '../../../services/businessProfile.service';
import { useMutationWithToast } from '../../../hooks';
import { usePermissions } from '../../../contexts/PermissionsContext';
import { useLeaveGuard, useUnsavedChanges } from '../../../contexts/UnsavedChangesContext';
import { FlowField, FrameFields, OccasionFields } from './ProjectInquiryFields';
import { EMPTY_DRAFT, changedKeys, draftError, fieldsFromDraft, type ProjectDraft } from './projectDraft';
import type { CustomerChoice } from './ProjectSideCards';

const NO_CUSTOMER: CustomerChoice = { id: null, label: '', isPassive: false };

type PickedCustomer = { id: number; email: string; companyName: string | null; displayName: string | null; lastName: string | null; isPassive?: boolean };
const choiceFrom = (c: PickedCustomer): CustomerChoice => ({
  id: c.id,
  label: c.companyName || c.displayName || c.email,
  isPassive: Boolean(c.isPassive),
  nameHint: c.lastName || c.companyName || c.displayName || '',
});

const Section: React.FC<{ icon: React.ReactNode; title: string; description: string; children: React.ReactNode }> = ({ icon, title, description, children }) => (
  <Card>
    <h2 className="flex items-center gap-2 text-base font-semibold text-heading">{icon}{title}</h2>
    <p className="text-sm text-muted mt-0.5 mb-4">{description}</p>
    {children}
  </Card>
);

export const NewInquiryPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { unguarded } = useLeaveGuard();
  const { hasPermission } = usePermissions();
  const canViewCustomers = hasPermission('customers.view');

  const [customer, setCustomer] = useState<CustomerChoice>(NO_CUSTOMER);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [submitted, setSubmitted] = useState(false);

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['event-types-active'],
    queryFn: () => eventTypesService.getActiveEventTypes(),
  });
  // GET /admin/business-profile needs settings.view or settings.banking.
  const { data: profileSnap } = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => businessProfileService.get(),
    enabled: hasPermission('settings.view') || hasPermission('settings.banking'),
    retry: false,
  });
  const defaultCurrency = profileSnap?.profile.defaultCurrency || undefined;

  // Until the admin types a name: the occasion and the customer's last name
  // (or company), e.g. "Wedding Keller". Only a suggestion; it never reaches
  // the customer.
  const suggestedName = useMemo(() => {
    const type = eventTypes.find((et) => et.slug_prefix === draft.eventType)?.name;
    return [type, customer.nameHint].filter(Boolean).join(' ');
  }, [eventTypes, draft.eventType, customer.nameHint]);
  const effectiveName = nameTouched ? name : suggestedName;

  const isDirty = customer.id !== null || nameTouched || changedKeys(draft, EMPTY_DRAFT).length > 0;
  useUnsavedChanges(isDirty, () => { setCustomer(NO_CUSTOMER); setName(''); setNameTouched(false); setDraft(EMPTY_DRAFT); });

  const nameMissing = !effectiveName.trim();
  const customerMissing = canViewCustomers && !customer.id;

  const create = useMutationWithToast({
    mutationFn: () => projectsService.create({
      name: effectiveName.trim(),
      customerAccountId: customer.id,
      status: 'inquiry',
      ...fieldsFromDraft({ ...draft, currency: draft.currency || (draft.budget > 0 && defaultCurrency ? defaultCurrency : '') }),
    }),
    successMessage: t('projects.inquiry.created', 'Inquiry saved.') as string,
    errorMessage: t('projects.inquiry.createFailed', 'Could not save the inquiry') as string,
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      unguarded(() => navigate(`/admin/clients/projects/${project.id}`));
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (nameMissing || customerMissing || draftError(draft)) return;
    create.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="max-w-3xl" noValidate>
      <SectionPageHeader
        icon={Inbox}
        title={t('projects.inquiry.title', 'New inquiry')}
        description={t('projects.inquiry.subtitle', 'Write down what the customer asked for. Quote, contract, gallery and invoice take this data later.')}
        feature="projects"
      />

      <div className="space-y-4">
        <Section
          icon={<User className="w-5 h-5" />}
          title={t('projects.customer.title', 'Customer')}
          description={t('projects.inquiry.customerHelp', 'Who asked? Pick an existing customer or add a new one. A new customer gets no email until you invite them.')}
        >
          {canViewCustomers ? (
            <CustomerPicker
              value={customer.id}
              label={customer.label}
              isPassive={customer.isPassive}
              onSelect={(c) => setCustomer(choiceFrom(c))}
              onCreate={(c) => setCustomer(choiceFrom(c))}
              onClear={() => setCustomer(NO_CUSTOMER)}
            />
          ) : (
            <p className="text-sm text-muted">{t('projects.inquiry.noCustomerPermission', 'You cannot pick customers. The project is saved without one; someone with access to customers can add it later.')}</p>
          )}
          {submitted && customerMissing && (
            <p className="mt-2 text-sm text-danger-text">{t('projects.inquiry.customerRequired', 'Pick or add the customer.')}</p>
          )}
        </Section>

        <Section
          icon={<Calendar className="w-5 h-5" />}
          title={t('projects.inquiry.occasionTitle', 'Occasion')}
          description={t('projects.inquiry.occasionHelp', 'What is it about, when and where?')}
        >
          <div className="space-y-4">
            <Input
              label={t('projects.renameLabel', 'Project name') as string}
              value={effectiveName}
              maxLength={255}
              onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
              error={submitted && nameMissing ? (t('projects.inquiry.nameRequired', 'Give the project a name.') as string) : undefined}
              helperText={t('projects.inquiry.nameHelp', 'Suggested from the occasion and the customer. Only shown in the admin, never to the customer.') as string}
            />
            <OccasionFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
          </div>
        </Section>

        <Section
          icon={<Route className="w-5 h-5" />}
          title={t('projects.flow.title', 'Workflow')}
          description={t('projects.flow.sectionHelp', 'Which steps this job has. You can change it later.')}
        >
          <FlowField draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        </Section>

        <Section
          icon={<Wallet className="w-5 h-5" />}
          title={t('projects.inquiry.frameTitle', 'Scope')}
          description={t('projects.inquiry.frameHelp', 'What you need to know for the quote.')}
        >
          <FrameFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} defaultCurrency={defaultCurrency} />
        </Section>
      </div>

      <div className="flex flex-wrap justify-end gap-2 mt-6">
        <Button type="button" variant="outline" onClick={() => unguarded(() => navigate('/admin/clients/projects'))}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button type="submit" variant="primary" isLoading={create.isPending}>
          {t('projects.inquiry.save', 'Save inquiry')}
        </Button>
      </div>
    </form>
  );
};

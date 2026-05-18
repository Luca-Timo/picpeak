/**
 * Admin → Customer detail / edit (#354).
 *
 * Mounted at /admin/customers/:id. Editable view of every field on the
 * customer_accounts table — name, salutation, address, billing, notes —
 * so an admin can keep the record current for future quotes/invoicing
 * features. Also lists the events the customer is currently assigned to
 * (linked to the event detail page; assignments themselves are managed
 * from the event form, not here).
 */
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  ArrowLeft, Mail, MapPin, Phone, Building2, Save, Trash2, AlertTriangle,
  CheckCircle2, X, FileText, Calendar, KeyRound, ToggleLeft, Settings as SettingsIcon,
  Clock,
} from 'lucide-react';
import { format } from 'date-fns';

import { Button, Card, Input, Loading } from '../../components/common';
import { AssignedEventsDialog } from '../../components/admin/AssignedEventsDialog';
import {
  customerAdminService,
  type CustomerAccountDetail,
} from '../../services/customerAdmin.service';
import { businessProfileService } from '../../services/businessProfile.service';
import { CustomerCrmPanels } from '../../components/admin/CustomerCrmPanels';

type EditableFields =
  | 'email' | 'salutation' | 'firstName' | 'lastName' | 'displayName'
  | 'phone' | 'companyName' | 'billingEmail' | 'vatId'
  | 'addressLine1' | 'addressLine2' | 'postalCode' | 'city' | 'state'
  | 'countryCode' | 'countryName' | 'preferredLanguage' | 'notes'
  | 'featureCalendar' | 'featureQuotes' | 'featureBills' | 'featureHoursLogging'
  | 'hourlyRateMinor';

const formatDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  try { return format(new Date(iso), 'PP'); } catch { return '—'; }
};

export const CustomerDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const customerId = Number(id);

  const { data: customer, isLoading, error } = useQuery({
    queryKey: ['admin-customer', customerId],
    queryFn: () => customerAdminService.get(customerId),
    enabled: Number.isFinite(customerId) && customerId > 0,
  });

  // Business-profile default locale powers the "Preferred language"
  // dropdown's helper hint — admins see which language a brand-new
  // customer would inherit and decide whether to override it.
  const { data: profileSnapshot } = useQuery({
    queryKey: ['business-profile-snapshot'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60 * 1000,
  });
  const profileDefaultLocale = profileSnapshot?.profile?.defaultLocale || 'en';
  const LOCALE_LABELS: Record<string, string> = {
    en: 'English', de: 'Deutsch', fr: 'Français',
    nl: 'Nederlands', pt: 'Português', ru: 'Русский',
  };

  const [form, setForm] = useState<Partial<Pick<CustomerAccountDetail, EditableFields>>>({});
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  // Drives the "Manage galleries" modal launched from the Assigned
  // events card. We hold open-state here (rather than inside the
  // dialog) so the parent decides when to mount/unmount and the
  // dialog can hard-reset its internal state per open.
  const [assignedDialogOpen, setAssignedDialogOpen] = useState(false);

  // Hydrate the form from the fetched record once. We deliberately do NOT
  // re-sync on every refetch so an admin's in-progress edits aren't blown
  // away by a background refresh.
  useEffect(() => {
    if (customer && Object.keys(form).length === 0) {
      setForm({
        email: customer.email,
        salutation: customer.salutation,
        firstName: customer.firstName,
        lastName: customer.lastName,
        displayName: customer.displayName,
        phone: customer.phone,
        companyName: customer.companyName,
        billingEmail: customer.billingEmail,
        vatId: customer.vatId,
        addressLine1: customer.addressLine1,
        addressLine2: customer.addressLine2,
        postalCode: customer.postalCode,
        city: customer.city,
        state: customer.state,
        countryCode: customer.countryCode,
        countryName: customer.countryName,
        preferredLanguage: customer.preferredLanguage,
        notes: customer.notes,
        featureCalendar: customer.featureCalendar ?? false,
        featureQuotes:   customer.featureQuotes   ?? false,
        featureBills:    customer.featureBills    ?? false,
        featureHoursLogging: customer.featureHoursLogging ?? false,
        hourlyRateMinor: customer.hourlyRateMinor ?? null,
      } as any);
    }
  }, [customer, form]);

  const toggleFeature = (key: 'featureCalendar' | 'featureQuotes' | 'featureBills' | 'featureHoursLogging') => {
    setForm((prev) => ({ ...prev, [key]: !prev[key] }) as any);
  };

  const setField = (key: EditableFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const saveMutation = useMutation({
    mutationFn: () => customerAdminService.update(customerId, form),
    onSuccess: (updated) => {
      queryClient.setQueryData(['admin-customer', customerId], updated);
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.detail.saved', 'Customer saved'));
    },
    onError: (e: any) => {
      const msg = e?.response?.status === 409
        ? t('customers.detail.emailConflict', 'That email is already in use by another customer.')
        : e?.response?.data?.error || t('customers.detail.saveError', 'Could not save changes.');
      toast.error(msg);
    },
  });

  /**
   * Trigger a password-reset email. Reused permission `customers.create`
   * server-side because issuing a reset is the same authority level as
   * issuing an invitation (both put a credential in the customer's mailbox).
   * Confirm dialog ahead of the click is surfaced via the same modal
   * pattern as deactivate.
   */
  const passwordResetMutation = useMutation({
    mutationFn: () => customerAdminService.sendPasswordReset(customerId),
    onSuccess: () => toast.success(t('customers.detail.passwordReset.success', 'Password reset email sent')),
    onError: () => toast.error(t('customers.detail.passwordReset.error', 'Could not send password reset')),
  });

  // Promote a passive customer to active by firing the standard
  // portal-invitation email. On success we invalidate the customer
  // query so the badge + the "Has portal access" copy update once
  // the customer actually claims the invite (next reload).
  const sendInviteMutation = useMutation({
    mutationFn: () => customerAdminService.sendInvite(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      toast.success(t('customers.passive.sendInviteToast', 'Portal invitation sent.'));
    },
    onError: (err: any) => {
      if (err?.response?.data?.code === 'CUSTOMER_ALREADY_ACTIVE') {
        toast.error(t('customers.passive.alreadyActive',
          'Customer already has portal access — no invitation needed.'));
      } else {
        toast.error(err?.response?.data?.error || err?.message || t('common.error', 'Something went wrong.'));
      }
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: () => customerAdminService.deactivate(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.deactivate.success', 'Customer deactivated'));
      navigate('/admin/clients/accounts');
    },
    onError: () => toast.error(t('customers.deactivate.error', 'Could not deactivate customer')),
  });

  /** Re-enable login for a deactivated customer. */
  const reactivateMutation = useMutation({
    mutationFn: () => customerAdminService.reactivate(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.reactivate.success', 'Customer reactivated'));
    },
    onError: () => toast.error(t('customers.reactivate.error', 'Could not reactivate customer')),
  });

  /**
   * Anonymize-in-place erasure. Two-step UX: requires the customer to be
   * deactivated first, then a separate confirm modal. Hard delete is
   * deliberately NOT exposed — see service notes for why.
   */
  const eraseMutation = useMutation({
    mutationFn: () => customerAdminService.erase(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.erase.success', 'Customer erased'));
      navigate('/admin/clients/accounts');
    },
    onError: () => toast.error(t('customers.erase.error', 'Could not erase customer')),
  });

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loading /></div>;
  }
  if (error || !customer) {
    return (
      <div className="container py-6">
        <div className="text-sm text-red-600 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {t('customers.detail.loadError', 'Could not load customer')}
        </div>
      </div>
    );
  }

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/admin/clients/accounts"
            className="p-2 -ml-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft className="w-4 h-4 text-muted-theme" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-theme truncate">
              {customer.displayName || customer.email}
            </h1>
            <p className="text-sm text-muted-theme truncate">{customer.email}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {customer.isActive ? (
            <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--color-accent)' }}>
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t('customers.status.active', 'Active')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-red-600">
              <X className="w-3.5 h-3.5" />
              {t('customers.status.inactive', 'Deactivated')}
            </span>
          )}
          {customer.isPassive ? (
            <span
              className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
              title={t(
                'customers.passive.detailHint',
                'This customer has no portal access (admin-only record). Click "Send portal invitation" below to email them a sign-up link.',
              ) as string}
            >
              {t('customers.passive.badge', 'Passive — admin only')}
            </span>
          ) : (
            <span className="text-[11px] text-muted-theme">
              {t('customers.passive.activeLabel', 'Has portal access')}
            </span>
          )}
        </div>
      </div>

      {/* Account section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-4 flex items-center gap-2">
          <Mail className="w-5 h-5" /> {t('customers.detail.accountSection', 'Account')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.email', 'Email')}</label>
            <Input type="email" value={form.email || ''} onChange={setField('email')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.preferredLanguage', 'Preferred language')}</label>
            <select
              value={form.preferredLanguage || profileDefaultLocale}
              onChange={setField('preferredLanguage')}
              className="input"
            >
              <option value="en">English</option>
              <option value="de">Deutsch</option>
              <option value="fr">Français</option>
              <option value="nl">Nederlands</option>
              <option value="pt">Português</option>
              <option value="ru">Русский</option>
            </select>
            <p className="text-xs text-neutral-500 mt-1">
              {t('customers.detail.preferredLanguageHint',
                'Drives portal UI and quote/invoice PDF locale. New customers default to the business-profile language ({{lang}}); override here per customer.',
                { lang: LOCALE_LABELS[profileDefaultLocale] || profileDefaultLocale.toUpperCase() })}
            </p>
          </div>
        </div>
      </Card>

      {/* Personal section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-4">
          {t('customers.detail.personalSection', 'Personal information')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.salutation', 'Salutation')}</label>
            {/* Salutation values are stored verbatim in the DB ("Herr",
                "Frau", "Mx", "Dr") — those are the canonical token values
                across locales. Display labels are translated; the value
                attribute stays in the German form so existing rows
                remain valid regardless of which locale the admin is
                viewing the dropdown in. */}
            <select
              value={form.salutation || ''}
              onChange={setField('salutation')}
              className="input"
            >
              <option value="">{t('customer.profile.salutation.none', '— Not specified —')}</option>
              <option value="Herr">{t('customer.profile.salutation.herr', 'Mr.')}</option>
              <option value="Frau">{t('customer.profile.salutation.frau', 'Ms.')}</option>
              <option value="Mx">{t('customer.profile.salutation.mx', 'Mx')}</option>
              <option value="Dr">{t('customer.profile.salutation.dr', 'Dr.')}</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.firstName', 'First name')}</label>
            <Input value={form.firstName || ''} onChange={setField('firstName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.lastName', 'Last name')}</label>
            <Input value={form.lastName || ''} onChange={setField('lastName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.displayName', 'Display name')}</label>
            <Input value={form.displayName || ''} onChange={setField('displayName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1 flex items-center gap-1">
              <Phone className="w-4 h-4" /> {t('customers.detail.phone', 'Phone')}
            </label>
            <Input value={form.phone || ''} onChange={setField('phone')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1 flex items-center gap-1">
              <Building2 className="w-4 h-4" /> {t('customers.detail.company', 'Company')}
            </label>
            <Input value={form.companyName || ''} onChange={setField('companyName')} />
          </div>
        </div>
      </Card>

      {/* Section order rationale (follow-up reorder request): the
          customer detail page now flows from "who they are" (Personal)
          → "what we know about them" (Notes) → "what they've worked
          with us on" (Events) → "how to bill them" (Billing) → "what
          they can do in the portal" (Features) → "destructive admin
          actions" (Actions). Notes + Events promoted out from below
          billing/features because they're the surfaces admins glance
          at most when opening a customer record. */}

      {/* Notes (admin-only) */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-4 flex items-center gap-2">
          <FileText className="w-5 h-5" /> {t('customers.detail.notesSection', 'Internal notes')}
        </h2>
        <p className="text-xs text-muted-theme mb-3">
          {t('customers.detail.notesHint', 'Visible only to admins. Never shown to the customer.')}
        </p>
        <textarea
          value={form.notes || ''}
          onChange={setField('notes') as any}
          rows={4}
          className="input w-full"
        />
      </Card>

      {/* Assigned events */}
      <Card padding="lg">
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <h2 className="text-lg font-semibold text-theme flex items-center gap-2">
            <Calendar className="w-5 h-5" /> {t('customers.detail.eventsSection', 'Assigned events')}
          </h2>
          {/* Manage galleries: opens the multi-select dialog that
              replaces the customer's full assignment list. Disabled
              for deactivated customers because their login is off
              anyway — re-enable first if the admin wants to plan
              their access. */}
          <Button
            variant="outline"
            size="sm"
            leftIcon={<SettingsIcon className="w-4 h-4" />}
            onClick={() => setAssignedDialogOpen(true)}
            disabled={!customer.isActive}
          >
            {t('customers.detail.manageEvents', 'Manage galleries')}
          </Button>
        </div>
        {customer.events.length === 0 ? (
          <p className="text-sm text-muted-theme">
            {t('customers.detail.noEvents', 'Not assigned to any events yet. Use "Manage galleries" to add some.')}
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {customer.events.map((ev) => (
              <li key={ev.id} className="py-2 flex items-center justify-between">
                <Link to={`/admin/events/${ev.id}`} className="text-theme hover:underline">
                  {ev.eventName}
                </Link>
                <span className="text-xs text-muted-theme">
                  {ev.eventDate ? formatDate(ev.eventDate) : ''}
                  {ev.expiresAt ? ` · ${t('customers.detail.expires', 'expires')} ${formatDate(ev.expiresAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AssignedEventsDialog
        customerId={customer.id}
        isOpen={assignedDialogOpen}
        initial={customer.events.map((ev) => ({
          id: ev.id,
          eventName: ev.eventName,
          eventDate: ev.eventDate || null,
        }))}
        onClose={() => setAssignedDialogOpen(false)}
        onSaved={() => {
          // Parent refetch is handled by the dialog's invalidateQueries.
        }}
      />

      {/* Address + billing */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-4 flex items-center gap-2">
          <MapPin className="w-5 h-5" /> {t('customers.detail.billingSection', 'Address & billing')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.billingEmail', 'Billing email')}</label>
            <Input type="email" value={form.billingEmail || ''} onChange={setField('billingEmail')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.vatId', 'VAT / tax ID')}</label>
            <Input value={form.vatId || ''} onChange={setField('vatId')} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.addressLine1', 'Address line 1')}</label>
            <Input value={form.addressLine1 || ''} onChange={setField('addressLine1')} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.addressLine2', 'Address line 2')}</label>
            <Input value={form.addressLine2 || ''} onChange={setField('addressLine2')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.postalCode', 'Postal code')}</label>
            <Input value={form.postalCode || ''} onChange={setField('postalCode')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.city', 'City')}</label>
            <Input value={form.city || ''} onChange={setField('city')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.state', 'State / region')}</label>
            <Input value={form.state || ''} onChange={setField('state')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.countryCode', 'Country abbreviation (FL, CH, DE …)')}</label>
            <Input
              value={form.countryCode || ''}
              onChange={setField('countryCode')}
              maxLength={2}
              placeholder="FL"
            />
          </div>
          <div>
            {/* Free-text country name override (migration 107). When
                left empty the PDF renderer falls back to the locale-
                aware lookup on the abbreviation; useful when the
                abbreviation isn't an ISO code (e.g. "FL" for
                Liechtenstein, which is "LI" in ISO). */}
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.countryName', 'Country (full name)')}</label>
            <Input
              value={form.countryName || ''}
              onChange={setField('countryName')}
              placeholder="Liechtenstein"
            />
          </div>
        </div>
      </Card>

      {/* Quotes + Invoices history (CRM #TBD).
          Each panel renders a compact list scoped to this customer. The
          panels are independently feature-flagged so they vanish for
          installs that haven't turned the master quotes/bills flag on.
          The flag check lives in <CustomerCrmPanels /> so this page
          doesn't need to import useFeatureFlags directly. */}
      <CustomerCrmPanels customerAccountId={customer.id} />

      {/* Per-customer feature flags (#354 follow-up). Sits
          second-to-last by request — admins glance at these least
          often, but they need to live above the destructive
          "Account actions" row so the feature surface and its
          actions read as one unit. */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-1 flex items-center gap-2">
          <ToggleLeft className="w-5 h-5" />
          {t('customers.detail.featuresSection', 'Customer features')}
        </h2>
        <p className="text-xs text-muted-theme mb-4">
          {t(
            'customers.detail.featuresHint',
            'Per-customer overrides for the customer-surface tabs. The global toggles in Settings → Features are the master switch — when global is OFF nobody sees the tab, regardless of what you set here. Defaults are ON, so flip a switch OFF to hide a tab for this specific customer.'
          )}
        </p>
        <div className="space-y-3">
          {([
            { key: 'featureCalendar', labelKey: 'customer.nav.calendar', fallback: 'Calendar' },
            { key: 'featureQuotes',   labelKey: 'customer.nav.quotes',   fallback: 'Quotes' },
            { key: 'featureBills',    labelKey: 'customer.nav.bills',    fallback: 'Bills' },
            { key: 'featureHoursLogging', labelKey: 'customers.field.featureHoursLogging', fallback: 'Hours logging' },
          ] as const).map(({ key, labelKey, fallback }) => {
            const enabled = !!form[key];
            return (
              <label key={key} className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="text-sm font-medium text-theme flex items-center gap-2">
                  {t(labelKey, fallback)}
                  {/* Soon badge — these tabs are still coming-soon stubs;
                      this keeps the admin honest when looking at the
                      toggles. */}
                  <span
                    className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                  >
                    {t('customer.nav.soon', 'Soon')}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => toggleFeature(key)}
                  className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                  style={{ backgroundColor: enabled ? 'var(--color-accent)' : 'var(--color-surface-border)' }}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </label>
            );
          })}
        </div>
      </Card>

      {/* Hours section (migration 129). Only renders when the
          feature_hours_logging toggle above is on. Lives between
          features and account-actions so admins see it right after
          flipping the toggle. */}
      {form.featureHoursLogging && (
        <HoursSection
          customerId={customerId}
          customerHourlyRateMinor={form.hourlyRateMinor ?? null}
          billingCadence={customer.billingCadence || 'per_event'}
          onHourlyRateChange={(v) => setForm((prev) => ({ ...prev, hourlyRateMinor: v } as any))}
        />
      )}

      {/* Account actions: password reset OR portal invitation
          (#354 follow-up + passive-customer flow). Passive customers
          don't have a password to reset — the equivalent action is
          firing the standard portal-invitation email. We show ONE
          card with the right action based on the customer's state. */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-1 flex items-center gap-2">
          <KeyRound className="w-5 h-5" />
          {t('customers.detail.passwordSection', 'Account actions')}
        </h2>
        {customer.isPassive ? (
          <>
            <p className="text-xs text-muted-theme mb-4">
              {t(
                'customers.passive.detailHint',
                'This customer has no portal access (admin-only record). Click below to email them a portal sign-up link. The customer\'s existing invoices, quotes, and gallery assignments are preserved when they claim the invitation.',
              )}
            </p>
            <Button
              variant="primary"
              leftIcon={<KeyRound className="w-4 h-4" />}
              isLoading={sendInviteMutation.isPending}
              disabled={!customer.isActive || sendInviteMutation.isPending}
              onClick={() => sendInviteMutation.mutate()}
            >
              {t('customers.passive.sendInvite', 'Send portal invitation')}
            </Button>
            {!customer.isActive && (
              <p className="text-xs text-muted-theme mt-2">
                {t('customers.passive.deactivatedHint',
                  'Reactivate the customer before sending the invitation.')}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted-theme mb-4">
              {t(
                'customers.detail.passwordHint',
                'Sends a 7-day single-use reset link to the customer\'s email. The customer\'s current password keeps working until they click the link and set a new one.'
              )}
            </p>
            <Button
              variant="outline"
              leftIcon={<KeyRound className="w-4 h-4" />}
              isLoading={passwordResetMutation.isPending}
              disabled={!customer.isActive}
              onClick={() => passwordResetMutation.mutate()}
            >
              {t('customers.detail.passwordReset.button', 'Send password reset email')}
            </Button>
            {!customer.isActive && (
              <p className="text-xs text-muted-theme mt-2">
                {t('customers.detail.passwordReset.inactive', 'Reactivate the customer before sending a reset.')}
              </p>
            )}
          </>
        )}
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {customer.isActive ? (
            <Button
              variant="outline"
              leftIcon={<Trash2 className="w-4 h-4" />}
              onClick={() => setConfirmDeactivate(true)}
            >
              {t('customers.deactivate.button', 'Deactivate')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                leftIcon={<CheckCircle2 className="w-4 h-4" />}
                isLoading={reactivateMutation.isPending}
                onClick={() => reactivateMutation.mutate()}
              >
                {t('customers.reactivate.button', 'Reactivate')}
              </Button>
              {/* Erase is only offered when the customer is already
                  inactive — forces a deliberate two-step (deactivate
                  → erase) and removes the chance of misclicking through
                  the deactivate button on a live account. */}
              <Button
                variant="outline"
                leftIcon={<Trash2 className="w-4 h-4 text-red-600" />}
                onClick={() => setConfirmErase(true)}
              >
                <span className="text-red-600">
                  {t('customers.erase.button', 'Erase customer data')}
                </span>
              </Button>
            </>
          )}
        </div>
        <Button
          variant="primary"
          leftIcon={<Save className="w-4 h-4" />}
          isLoading={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {t('customers.detail.save', 'Save changes')}
        </Button>
      </div>

      {confirmDeactivate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-xl shadow-lg" style={{ backgroundColor: 'var(--color-surface)' }}>
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-amber-500" />
                <div>
                  <h2 className="text-lg font-semibold text-theme">
                    {t('customers.deactivate.title', 'Deactivate customer?')}
                  </h2>
                  <p className="mt-1 text-sm text-muted-theme">
                    {t('customers.deactivate.body',
                      'They will no longer be able to log in. You can re-activate or fully erase them later.')}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setConfirmDeactivate(false)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  variant="primary"
                  isLoading={deactivateMutation.isPending}
                  onClick={() => { deactivateMutation.mutate(); setConfirmDeactivate(false); }}
                >
                  {t('common.confirm', 'Confirm')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Erase confirm modal — second step after deactivate. Spelled out
          "irreversible" copy + red Confirm button so the click feels
          deliberate. The action anonymizes PII in place; assignments
          and audit-log references are preserved. */}
      {confirmErase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-xl shadow-lg" style={{ backgroundColor: 'var(--color-surface)' }}>
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-red-600" />
                <div>
                  <h2 className="text-lg font-semibold text-theme">
                    {t('customers.erase.title', 'Erase customer data?')}
                  </h2>
                  <p className="mt-1 text-sm text-muted-theme">
                    {t('customers.erase.body',
                      'Removes the customer\'s name, email, phone, address, company and credentials. The account row stays so historical event-access records and audit logs still reference it. This is irreversible — you cannot restore the data afterwards.')}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setConfirmErase(false)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
                  disabled={eraseMutation.isPending}
                  onClick={() => { eraseMutation.mutate(); setConfirmErase(false); }}
                >
                  {eraseMutation.isPending
                    ? t('customers.erase.confirmInFlight', 'Erasing…')
                    : t('customers.erase.confirm', 'Erase permanently')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerDetailPage;

// ---------------------------------------------------------------------
// Hours section card (migration 129).
//
// Rendered only when feature_hours_logging is on. Holds the default
// hourly rate input + the entry list + an inline "Log new entry" form.
// Talks to the backend via customerAdminService.{list,create,update,
// delete,billUnbilled}HourEntries — all writes go through react-query
// invalidation so the list refreshes after every action.
// ---------------------------------------------------------------------
interface HoursSectionProps {
  customerId: number;
  customerHourlyRateMinor: number | null;
  billingCadence: 'per_event' | 'monthly' | 'quarterly';
  onHourlyRateChange: (next: number | null) => void;
}

const HoursSection: React.FC<HoursSectionProps> = ({
  customerId, customerHourlyRateMinor, billingCadence, onHourlyRateChange,
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [rateOverride, setRateOverride] = useState<string>('');
  const [description, setDescription] = useState('');

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['admin-customer-hour-entries', customerId],
    queryFn: () => customerAdminService.listHourEntries(customerId),
    enabled: Number.isFinite(customerId) && customerId > 0,
  });

  const createMutation = useMutation({
    mutationFn: () => customerAdminService.createHourEntry(customerId, {
      entryDate, startTime, endTime,
      hourlyRateMinorOverride: rateOverride ? Math.round(Number(rateOverride) * 100) : null,
      description: description || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
      qc.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      setStartTime('09:00');
      setEndTime('10:00');
      setRateOverride('');
      setDescription('');
      toast.success(t('customers.hours.toast.created', 'Entry logged'));
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error || err?.message || 'Failed to log entry';
      toast.error(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entryId: number) => customerAdminService.deleteHourEntry(customerId, entryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
      qc.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      toast.success(t('customers.hours.toast.deleted', 'Entry deleted'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || 'Failed to delete entry');
    },
  });

  const billMutation = useMutation({
    mutationFn: () => customerAdminService.billUnbilledHourEntries(customerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
      qc.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      toast.success(t('customers.hours.toast.billed', 'Hours billed'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || 'Failed to bill hours');
    },
  });

  const unbilledCount = entries.filter((e) => e.status === 'unbilled').length;
  const isMonthly = billingCadence === 'monthly';

  // Local lockout check — mirrors customerHoursService.isEntryLocked
  // so the delete button can be disabled before the request is sent.
  const isLocked = (entry: typeof entries[number]) => {
    if (!entry.invoiceId) return false;
    if (entry.invoiceIsMonthlyDraft) return false;
    if (entry.invoiceStatus !== 'scheduled') return true;
    if (!entry.invoiceScheduledSendAt) return false;
    return new Date(entry.invoiceScheduledSendAt).getTime() <= Date.now();
  };

  return (
    <Card padding="lg">
      <h2 className="text-lg font-semibold text-theme mb-1 flex items-center gap-2">
        <Clock className="w-5 h-5" />
        {t('customers.hours.section', 'Hours')}
      </h2>
      <p className="text-xs text-muted-theme mb-4">
        {isMonthly
          ? t('customers.hours.monthlyHint',
            'Entries auto-append to the current monthly draft. Edit / delete remains possible until the scheduler arms the draft for send.')
          : t('customers.hours.perEventHint',
            'Logged entries stay unbilled until you click "Bill these hours" — a standalone invoice is generated with one line per entry.')}
      </p>

      {/* Default rate — saved with the customer record via the
          existing save button on this page. Input is in major units;
          backend stores minor units. */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-theme mb-1">
          {t('customers.field.hourlyRate', 'Default hourly rate')}
        </label>
        <input
          type="number"
          step="0.01"
          min={0}
          value={customerHourlyRateMinor != null ? (customerHourlyRateMinor / 100).toFixed(2) : ''}
          onChange={(e) => {
            const raw = e.target.value;
            onHourlyRateChange(raw === '' ? null : Math.round(Number(raw) * 100));
          }}
          className="w-40 input"
          placeholder="150.00"
        />
        <p className="text-xs text-muted-theme mt-1">
          {t('customers.field.hourlyRateHint',
            'Major units (e.g. 150.00 for CHF 150). Leave blank to require a per-entry override on every block.')}
        </p>
      </div>

      {/* Inline log-new-entry form. */}
      <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4 mb-4">
        <h3 className="text-sm font-semibold mb-3">{t('customers.hours.form.title', 'Log new entry')}</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.date', 'Date')}
            </label>
            <input type="date" value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.start', 'Start')}
            </label>
            <input type="time" value={startTime}
              onChange={(e) => setStartTime(e.target.value)} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.end', 'End')}
            </label>
            <input type="time" value={endTime}
              onChange={(e) => setEndTime(e.target.value)} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.rateOverride', 'Rate override')}
            </label>
            <input type="number" step="0.01" min={0} value={rateOverride}
              onChange={(e) => setRateOverride(e.target.value)}
              placeholder={customerHourlyRateMinor != null
                ? (customerHourlyRateMinor / 100).toFixed(2)
                : '—'}
              className="input w-full" />
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-xs text-muted-theme mb-1">
            {t('customers.hours.form.note', 'Note / description')}
          </label>
          <textarea rows={2} value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input w-full text-sm"
            placeholder={t('customers.hours.form.notePlaceholder',
              'What was worked on?') as string} />
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            disabled={createMutation.isPending}
            isLoading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {t('customers.hours.form.save', 'Add entry')}
          </Button>
        </div>
      </div>

      {/* Bill-these-hours button for per-event customers only. */}
      {!isMonthly && unbilledCount > 0 && (
        <div className="mb-4 flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 rounded p-3">
          <span className="text-sm">
            {t('customers.hours.unbilledCount',
              '{{count}} unbilled entries totaling {{total}}',
              {
                count: unbilledCount,
                total: (entries
                  .filter((e) => e.status === 'unbilled')
                  .reduce((s, e) => s + ((e.hourlyRateMinorOverride ?? customerHourlyRateMinor ?? 0) * e.durationMinutes / 60), 0) / 100)
                  .toFixed(2),
              })}
          </span>
          <Button
            variant="primary"
            disabled={billMutation.isPending}
            isLoading={billMutation.isPending}
            onClick={() => billMutation.mutate()}
          >
            {t('customers.hours.billButton', 'Bill these hours')}
          </Button>
        </div>
      )}

      {/* Entry list table. */}
      {isLoading ? (
        <p className="text-sm text-muted-theme">{t('common.loading', 'Loading…')}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-theme">
          {t('customers.hours.empty', 'No entries logged yet.')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-theme">
                <th className="py-2 pr-3">{t('customers.hours.col.date', 'Date')}</th>
                <th className="py-2 pr-3">{t('customers.hours.col.range', 'Time')}</th>
                <th className="py-2 pr-3 text-right">{t('customers.hours.col.hours', 'Hours')}</th>
                <th className="py-2 pr-3 text-right">{t('customers.hours.col.rate', 'Rate')}</th>
                <th className="py-2 pr-3 text-right">{t('customers.hours.col.total', 'Total')}</th>
                <th className="py-2 pr-3">{t('customers.hours.col.note', 'Note')}</th>
                <th className="py-2 pr-3">{t('customers.hours.col.status', 'Status')}</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const rate = e.hourlyRateMinorOverride ?? customerHourlyRateMinor ?? 0;
                const hours = e.durationMinutes / 60;
                const total = (hours * rate) / 100;
                const locked = isLocked(e);
                return (
                  <tr key={e.id} className="border-t border-neutral-200 dark:border-neutral-700">
                    <td className="py-1.5 pr-3 tabular-nums">{e.entryDate}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{e.startTime}–{e.endTime}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{hours.toFixed(2)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{(rate / 100).toFixed(2)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{total.toFixed(2)}</td>
                    <td className="py-1.5 pr-3 max-w-xs truncate" title={e.description || ''}>
                      {e.description || '—'}
                    </td>
                    <td className="py-1.5 pr-3">
                      {e.status === 'billed' ? (
                        <span className="text-xs text-green-700 dark:text-green-300">
                          {e.invoiceNumber
                            ? t('customers.hours.status.billedOn',
                              'Billed: {{number}}', { number: e.invoiceNumber })
                            : t('customers.hours.status.billed', 'Billed')}
                        </span>
                      ) : (
                        <span className="text-xs text-amber-700 dark:text-amber-300">
                          {t('customers.hours.status.unbilled', 'Unbilled')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <button
                        type="button"
                        disabled={locked || deleteMutation.isPending}
                        onClick={() => {
                          if (window.confirm(t('customers.hours.confirmDelete',
                            'Delete this entry? If it has been billed onto a draft, the matching invoice line will also be removed.') as string)) {
                            deleteMutation.mutate(e.id);
                          }
                        }}
                        className="text-xs text-red-600 hover:underline disabled:text-neutral-400 disabled:cursor-not-allowed"
                        title={locked ? t('customers.hours.locked',
                          'Locked: invoice already armed for send') as string : undefined}
                      >
                        {t('common.delete', 'Delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};

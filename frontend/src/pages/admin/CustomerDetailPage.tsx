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
  CheckCircle2, X, FileText, Calendar,
} from 'lucide-react';
import { format } from 'date-fns';

import { Button, Card, Input, Loading } from '../../components/common';
import {
  customerAdminService,
  type CustomerAccountDetail,
} from '../../services/customerAdmin.service';

type EditableFields =
  | 'email' | 'salutation' | 'firstName' | 'lastName' | 'displayName'
  | 'phone' | 'companyName' | 'billingEmail' | 'vatId'
  | 'addressLine1' | 'addressLine2' | 'postalCode' | 'city' | 'state'
  | 'countryCode' | 'preferredLanguage' | 'notes';

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

  const [form, setForm] = useState<Partial<Pick<CustomerAccountDetail, EditableFields>>>({});
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

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
        preferredLanguage: customer.preferredLanguage,
        notes: customer.notes,
      });
    }
  }, [customer, form]);

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

  const deactivateMutation = useMutation({
    mutationFn: () => customerAdminService.deactivate(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.deactivate.success', 'Customer deactivated'));
      navigate('/admin/customers');
    },
    onError: () => toast.error(t('customers.deactivate.error', 'Could not deactivate customer')),
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
            to="/admin/customers"
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
        <div className="flex items-center gap-2">
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
              value={form.preferredLanguage || 'en'}
              onChange={setField('preferredLanguage')}
              className="input"
            >
              <option value="en">English</option>
              <option value="de">Deutsch</option>
              <option value="nl">Nederlands</option>
              <option value="pt">Português</option>
              <option value="ru">Русский</option>
            </select>
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
            <select
              value={form.salutation || ''}
              onChange={setField('salutation')}
              className="input"
            >
              <option value="">{t('customers.detail.salutationNone', '—')}</option>
              <option value="Herr">Herr</option>
              <option value="Frau">Frau</option>
              <option value="Mx">Mx</option>
              <option value="Dr">Dr</option>
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
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.countryCode', 'Country (ISO 2)')}</label>
            <Input
              value={form.countryCode || ''}
              onChange={setField('countryCode')}
              maxLength={2}
              placeholder="e.g. CH"
            />
          </div>
        </div>
      </Card>

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
        <h2 className="text-lg font-semibold text-theme mb-4 flex items-center gap-2">
          <Calendar className="w-5 h-5" /> {t('customers.detail.eventsSection', 'Assigned events')}
        </h2>
        {customer.events.length === 0 ? (
          <p className="text-sm text-muted-theme">
            {t('customers.detail.noEvents', 'Not assigned to any events yet. Add this customer to an event from the event form.')}
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

      {/* Actions */}
      <div className="flex items-center justify-between">
        {customer.isActive ? (
          <Button
            variant="outline"
            leftIcon={<Trash2 className="w-4 h-4" />}
            onClick={() => setConfirmDeactivate(true)}
          >
            {t('customers.deactivate.button', 'Deactivate')}
          </Button>
        ) : <span />}
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
                      'They will no longer be able to log in. You can re-invite them later.')}
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
    </div>
  );
};

export default CustomerDetailPage;

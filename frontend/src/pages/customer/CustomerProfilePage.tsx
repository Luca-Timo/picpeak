/**
 * Customer self-service profile (#354 follow-up).
 *
 * Mounted at /customer/profile. Lets the logged-in customer edit:
 *   - personal name (salutation / first / last / display)
 *   - contact (phone, company, VAT id)
 *   - billing address
 *   - password
 *
 * The layout intentionally mirrors the admin detail pages (sectioned
 * Cards, two-column form on wide screens, save buttons inside each section
 * so a customer who only wants to fix their phone number doesn't have to
 * scroll past the address). Email is read-only here — changing the login
 * credential is admin-only for the same reason it is on AdminUserDetail.
 *
 * Two endpoints are hit:
 *   - PUT  /api/customer/profile          (name + contact + address)
 *   - POST /api/customer/profile/password (password change with re-auth)
 *
 * The password section bumps password_changed_at on the server, which
 * silently logs other browser sessions out of this customer account on
 * their next request. The current session keeps its cookie so the user
 * doesn't get bounced to login mid-flow.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Save, User as UserIcon, MapPin, Phone, Mail } from 'lucide-react';

import { Button, Card, Input, Loading } from '../../components/common';
import {
  customerService,
  type CustomerProfileFull,
  type CustomerProfileUpdate,
} from '../../services/customer.service';

const SALUTATION_OPTIONS = [
  { value: '', labelKey: 'customer.profile.salutation.none', fallback: '— Not specified —' },
  { value: 'Herr', labelKey: 'customer.profile.salutation.herr', fallback: 'Herr' },
  { value: 'Frau', labelKey: 'customer.profile.salutation.frau', fallback: 'Frau' },
  { value: 'Mx', labelKey: 'customer.profile.salutation.mx', fallback: 'Mx' },
  { value: 'Dr', labelKey: 'customer.profile.salutation.dr', fallback: 'Dr.' },
];

/** Normalise a server profile into the local form-state shape (string | ''). */
function profileToForm(p: CustomerProfileFull): CustomerProfileUpdate {
  return {
    salutation: p.salutation ?? '',
    firstName: p.firstName ?? '',
    lastName: p.lastName ?? '',
    displayName: p.displayName ?? '',
    phone: p.phone ?? '',
    companyName: p.companyName ?? '',
    vatId: p.vatId ?? '',
    addressLine1: p.addressLine1 ?? '',
    addressLine2: p.addressLine2 ?? '',
    postalCode: p.postalCode ?? '',
    city: p.city ?? '',
    state: p.state ?? '',
    countryCode: p.countryCode ?? '',
    preferredLanguage: p.preferredLanguage ?? 'en',
  };
}

export const CustomerProfilePage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['customer-profile'],
    queryFn: () => customerService.getProfile(),
  });

  // Local form state — initialised from server profile, edited freely until
  // the user clicks Save. We keep it as a single object to make the diffing
  // for the PUT call straightforward.
  const [form, setForm] = useState<CustomerProfileUpdate>({});
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  // Password change is its own mini-form. Kept separate so the main save
  // doesn't accidentally sweep up half-typed password fields.
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwErrors, setPwErrors] = useState<Record<string, string>>({});
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (profile) setForm(profileToForm(profile));
  }, [profile]);

  const updateField = (key: keyof CustomerProfileUpdate, value: string) => {
    setForm((p) => ({ ...p, [key]: value }));
  };

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileErr(null);
    setSavingProfile(true);
    try {
      // Send empty strings as null so the server clears the row instead of
      // storing whitespace. The backend already coerces empty strings, but
      // doing it client-side keeps the request payload honest.
      const payload: CustomerProfileUpdate = {};
      for (const [k, v] of Object.entries(form)) {
        const key = k as keyof CustomerProfileUpdate;
        payload[key] = (typeof v === 'string' && v.trim() === '') ? null : v as any;
      }
      const updated = await customerService.updateProfile(payload);
      setForm(profileToForm(updated));
      qc.invalidateQueries({ queryKey: ['customer-profile'] });
      toast.success(t('customer.profile.savedToast', 'Profile saved'));
    } catch (err: any) {
      setProfileErr(err?.response?.data?.error || t('customer.profile.saveError', 'Could not save profile.'));
    } finally {
      setSavingProfile(false);
    }
  };

  const validatePassword = (): boolean => {
    const next: Record<string, string> = {};
    if (!pwForm.current) {
      next.current = t('customer.profile.password.currentRequired', 'Enter your current password');
    }
    if (pwForm.next.length < 8) {
      next.next = t('customer.profile.password.tooShort', 'At least 8 characters');
    }
    if (pwForm.next !== pwForm.confirm) {
      next.confirm = t('customer.profile.password.mismatch', 'Passwords do not match');
    }
    setPwErrors(next);
    return Object.keys(next).length === 0;
  };

  const handlePasswordSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validatePassword()) return;
    setSavingPassword(true);
    try {
      await customerService.changePassword(pwForm.current, pwForm.next);
      setPwForm({ current: '', next: '', confirm: '' });
      setPwErrors({});
      toast.success(t('customer.profile.password.savedToast', 'Password updated'));
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) {
        setPwErrors({ current: t('customer.profile.password.wrong', 'Current password is incorrect') });
      } else if (status === 400 && err?.response?.data?.details?.length) {
        setPwErrors({ next: err.response.data.details.join(' ') });
      } else {
        toast.error(t('customer.profile.password.error', 'Could not change password'));
      }
    } finally {
      setSavingPassword(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container py-12 flex justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="container py-12">
        <Card padding="lg">
          <p className="text-sm text-red-600">
            {t('customer.profile.loadError', 'Could not load your profile.')}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-theme">
          {t('customer.profile.title', 'Customer profile')}
        </h1>
        <p className="mt-1 text-sm text-muted-theme">
          {t('customer.profile.subtitle', 'Keep your contact and billing details up to date — they\'re shown on quotes and invoices once those features go live.')}
        </p>
      </div>

      {/* Personal info + contact + address — single combined form so a
          customer can update everything in one save. The visual sections
          are inside the form purely for grouping. */}
      <form onSubmit={handleProfileSave} className="space-y-6">
        <Card padding="lg">
          <div className="flex items-center gap-2 mb-4">
            <UserIcon className="w-5 h-5 text-muted-theme" />
            <h2 className="text-lg font-semibold text-theme">
              {t('customer.profile.section.personal', 'Personal information')}
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.email', 'Email (login)')}
              </label>
              <Input
                value={profile.email}
                readOnly
                disabled
                leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
              />
              <p className="mt-1 text-xs text-muted-theme">
                {t('customer.profile.field.emailHint', 'Contact your photographer if you need to change your login email.')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-theme mb-1" htmlFor="profile-salutation">
                {t('customer.profile.field.salutation', 'Salutation')}
              </label>
              <select
                id="profile-salutation"
                value={form.salutation || ''}
                onChange={(e) => updateField('salutation', e.target.value)}
                className="w-full rounded-lg border px-3 h-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                style={{
                  backgroundColor: 'var(--color-surface)',
                  borderColor: 'var(--color-surface-border)',
                  color: 'var(--color-text)',
                }}
              >
                {SALUTATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.labelKey, o.fallback)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.firstName', 'First name')}
              </label>
              <Input value={form.firstName || ''} onChange={(e) => updateField('firstName', e.target.value)} />
            </div>

            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.lastName', 'Last name')}
              </label>
              <Input value={form.lastName || ''} onChange={(e) => updateField('lastName', e.target.value)} />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.displayName', 'Display name')}
              </label>
              <Input value={form.displayName || ''} onChange={(e) => updateField('displayName', e.target.value)} />
              <p className="mt-1 text-xs text-muted-theme">
                {t('customer.profile.field.displayNameHint', 'How we greet you in the dashboard.')}
              </p>
            </div>
          </div>
        </Card>

        <Card padding="lg">
          <div className="flex items-center gap-2 mb-4">
            <Phone className="w-5 h-5 text-muted-theme" />
            <h2 className="text-lg font-semibold text-theme">
              {t('customer.profile.section.contact', 'Contact & business')}
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.phone', 'Phone')}
              </label>
              <Input
                value={form.phone || ''}
                onChange={(e) => updateField('phone', e.target.value)}
                autoComplete="tel"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.companyName', 'Company name')}
              </label>
              <Input value={form.companyName || ''} onChange={(e) => updateField('companyName', e.target.value)} />
            </div>

            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.vatId', 'VAT ID')}
              </label>
              <Input value={form.vatId || ''} onChange={(e) => updateField('vatId', e.target.value)} />
            </div>
          </div>
        </Card>

        <Card padding="lg">
          <div className="flex items-center gap-2 mb-4">
            <MapPin className="w-5 h-5 text-muted-theme" />
            <h2 className="text-lg font-semibold text-theme">
              {t('customer.profile.section.address', 'Billing address')}
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
            <div className="sm:col-span-6">
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.addressLine1', 'Address line 1')}
              </label>
              <Input
                value={form.addressLine1 || ''}
                onChange={(e) => updateField('addressLine1', e.target.value)}
                autoComplete="address-line1"
              />
            </div>

            <div className="sm:col-span-6">
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.addressLine2', 'Address line 2')}
              </label>
              <Input
                value={form.addressLine2 || ''}
                onChange={(e) => updateField('addressLine2', e.target.value)}
                autoComplete="address-line2"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.postalCode', 'Postal code')}
              </label>
              <Input
                value={form.postalCode || ''}
                onChange={(e) => updateField('postalCode', e.target.value)}
                autoComplete="postal-code"
              />
            </div>

            <div className="sm:col-span-3">
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.city', 'City')}
              </label>
              <Input
                value={form.city || ''}
                onChange={(e) => updateField('city', e.target.value)}
                autoComplete="address-level2"
              />
            </div>

            <div className="sm:col-span-1">
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.countryCode', 'Country')}
              </label>
              <Input
                value={form.countryCode || ''}
                onChange={(e) => updateField('countryCode', e.target.value.toUpperCase().slice(0, 2))}
                placeholder="DE"
                maxLength={2}
                autoComplete="country"
              />
            </div>

            <div className="sm:col-span-3">
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.profile.field.state', 'State / region')}
              </label>
              <Input
                value={form.state || ''}
                onChange={(e) => updateField('state', e.target.value)}
                autoComplete="address-level1"
              />
            </div>
          </div>
        </Card>

        {profileErr && (
          <p className="text-sm text-red-600">{profileErr}</p>
        )}

        <div className="flex justify-end">
          <Button type="submit" variant="primary" leftIcon={<Save className="w-4 h-4" />} isLoading={savingProfile}>
            {t('customer.profile.save', 'Save changes')}
          </Button>
        </div>
      </form>

      {/* Password change — separate form so it doesn't fight with the main
          save button and the user's password autofill never leaks into
          unrelated fields. */}
      <Card padding="lg">
        <div className="flex items-center gap-2 mb-4">
          <Lock className="w-5 h-5 text-muted-theme" />
          <h2 className="text-lg font-semibold text-theme">
            {t('customer.profile.section.password', 'Change password')}
          </h2>
        </div>

        <form onSubmit={handlePasswordSave} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-theme mb-1">
              {t('customer.profile.password.current', 'Current password')}
            </label>
            <Input
              type="password"
              value={pwForm.current}
              onChange={(e) => setPwForm((p) => ({ ...p, current: e.target.value }))}
              error={pwErrors.current}
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">
              {t('customer.profile.password.next', 'New password')}
            </label>
            <Input
              type="password"
              value={pwForm.next}
              onChange={(e) => setPwForm((p) => ({ ...p, next: e.target.value }))}
              error={pwErrors.next}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">
              {t('customer.profile.password.confirm', 'Confirm new password')}
            </label>
            <Input
              type="password"
              value={pwForm.confirm}
              onChange={(e) => setPwForm((p) => ({ ...p, confirm: e.target.value }))}
              error={pwErrors.confirm}
              autoComplete="new-password"
            />
          </div>
          <div className="sm:col-span-3">
            <p className="mt-1 text-xs text-muted-theme">
              {t('customer.profile.password.hint', 'At least 8 characters with one uppercase letter and one number.')}
            </p>
          </div>
          <div className="sm:col-span-3 flex justify-end">
            <Button type="submit" variant="primary" leftIcon={<Lock className="w-4 h-4" />} isLoading={savingPassword}>
              {t('customer.profile.password.submit', 'Update password')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
};

export default CustomerProfilePage;

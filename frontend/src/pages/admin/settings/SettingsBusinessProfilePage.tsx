/**
 * Settings → Business profile tab.
 *
 * Issuer block + bank-account roster used by every quote / invoice PDF.
 * Loads via businessProfileService.get(); each section persists via the
 * matching service method.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Star } from 'lucide-react';
import {
  businessProfileService,
  type BusinessProfile,
  type BankAccount,
  type QrFormat,
} from '../../../services/businessProfile.service';
import { Button, Card, Loading, Input } from '../../../components/common';
import { toast } from 'react-toastify';

export const SettingsBusinessProfilePage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => businessProfileService.get(),
  });

  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  useEffect(() => { if (data?.profile) setProfile(data.profile); }, [data]);

  const saveProfile = useMutation({
    mutationFn: () => profile ? businessProfileService.update(profile) : Promise.reject(),
    onSuccess: () => {
      toast.success(t('businessProfile.savedToast', 'Business profile saved.'));
      qc.invalidateQueries({ queryKey: ['business-profile'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || 'Save failed'),
  });

  if (isLoading || !profile) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{t('businessProfile.title', 'Business profile')}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('businessProfile.subtitle', 'Issuer block shown on every quote and invoice PDF.')}
          </p>
        </div>
        <Button onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}>
          {t('common.save', 'Save')}
        </Button>
      </div>

      <Card>
        <h3 className="font-semibold mb-3">{t('businessProfile.section.company', 'Company')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('businessProfile.field.companyName', 'Company name') as string} value={profile.companyName}
            onChange={(e) => setProfile({ ...profile, companyName: e.target.value })} />
          <Input label={t('businessProfile.field.vatId', 'VAT ID') as string} value={profile.vatId}
            onChange={(e) => setProfile({ ...profile, vatId: e.target.value })} />
          <Input label={t('businessProfile.field.addressLine1', 'Address line 1') as string} value={profile.addressLine1}
            onChange={(e) => setProfile({ ...profile, addressLine1: e.target.value })} />
          <Input label={t('businessProfile.field.addressLine2', 'Address line 2') as string} value={profile.addressLine2}
            onChange={(e) => setProfile({ ...profile, addressLine2: e.target.value })} />
          <Input label={t('businessProfile.field.postalCode', 'Postal code') as string} value={profile.postalCode}
            onChange={(e) => setProfile({ ...profile, postalCode: e.target.value })} />
          <Input label={t('businessProfile.field.city', 'City') as string} value={profile.city}
            onChange={(e) => setProfile({ ...profile, city: e.target.value })} />
          <Input label={t('businessProfile.field.state', 'State / Region') as string} value={profile.state}
            onChange={(e) => setProfile({ ...profile, state: e.target.value })} />
          <Input label={t('businessProfile.field.countryCode', 'Country (ISO 3166)') as string} value={profile.countryCode}
            maxLength={2}
            onChange={(e) => setProfile({ ...profile, countryCode: e.target.value.toUpperCase() })} />
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('businessProfile.section.contact', 'Contact')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('businessProfile.field.phone', 'Phone') as string} value={profile.phone}
            onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
          <Input label={t('businessProfile.field.mobile', 'Mobile') as string} value={profile.mobile}
            onChange={(e) => setProfile({ ...profile, mobile: e.target.value })} />
          <Input type="email" label={t('businessProfile.field.email', 'Email') as string} value={profile.email}
            onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
          <Input label={t('businessProfile.field.website', 'Website') as string} value={profile.website}
            onChange={(e) => setProfile({ ...profile, website: e.target.value })} />
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('businessProfile.section.defaults', 'Defaults')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('businessProfile.field.defaultCurrency', 'Default currency') as string} value={profile.defaultCurrency}
            maxLength={3} onChange={(e) => setProfile({ ...profile, defaultCurrency: e.target.value.toUpperCase() })} />
          <Input label={t('businessProfile.field.defaultLocale', 'Default locale') as string} value={profile.defaultLocale}
            maxLength={8} onChange={(e) => setProfile({ ...profile, defaultLocale: e.target.value })} />
          <Input label={t('businessProfile.field.vatLabel', 'VAT label (e.g. MwSt., VAT)') as string} value={profile.vatLabel}
            onChange={(e) => setProfile({ ...profile, vatLabel: e.target.value })} />
          <Input type="number" step="0.01" label={t('businessProfile.field.vatRateDefault', 'Default VAT rate %') as string}
            value={profile.vatRateDefault ?? 0}
            onChange={(e) => setProfile({ ...profile, vatRateDefault: Number(e.target.value) })} />
          <div>
            <label className="block text-sm font-medium mb-1">{t('businessProfile.field.defaultQrFormat', 'Default invoice QR')}</label>
            <select value={profile.defaultQrFormat} onChange={(e) => setProfile({ ...profile, defaultQrFormat: e.target.value as QrFormat })}
              className="w-full px-3 py-2 rounded-md border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option value="none">{t('businessProfile.qrFormat.none', 'None')}</option>
              <option value="swiss">{t('businessProfile.qrFormat.swiss', 'Swiss QR-bill (CH / LI)')}</option>
              <option value="epc">{t('businessProfile.qrFormat.epc', 'EPC QR (SEPA / EUR)')}</option>
            </select>
          </div>
          <Input label={t('businessProfile.field.footerLine', 'PDF footer line') as string} value={profile.footerLine}
            onChange={(e) => setProfile({ ...profile, footerLine: e.target.value })} />
        </div>
      </Card>

      <BankAccountsSection accounts={data?.bankAccounts ?? []} />
    </div>
  );
};

interface BankAccountsSectionProps { accounts: BankAccount[] }
const BankAccountsSection: React.FC<BankAccountsSectionProps> = ({ accounts }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    label: '', accountHolder: '', iban: '', bic: '', currency: 'CHF', isDefault: false,
  });

  const create = useMutation({
    mutationFn: () => businessProfileService.createBankAccount(draft),
    onSuccess: () => {
      toast.success(t('businessProfile.bankCreatedToast', 'Bank account added.'));
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      setAdding(false);
      setDraft({ label: '', accountHolder: '', iban: '', bic: '', currency: 'CHF', isDefault: false });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed'),
  });

  const setDefault = useMutation({
    mutationFn: (id: number) => businessProfileService.updateBankAccount(id, { isDefault: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['business-profile'] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => businessProfileService.deleteBankAccount(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      toast.success(t('businessProfile.bankDeletedToast', 'Bank account removed.'));
    },
  });

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{t('businessProfile.section.banks', 'Bank accounts')}</h3>
        <Button size="sm" onClick={() => setAdding(!adding)}>
          <Plus className="w-4 h-4 mr-1" />{t('businessProfile.addBank', 'Add account')}
        </Button>
      </div>

      {adding && (
        <div className="mb-4 p-3 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input label={t('businessProfile.bank.label', 'Label') as string} value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            <Input label={t('businessProfile.bank.accountHolder', 'Account holder') as string} value={draft.accountHolder}
              onChange={(e) => setDraft({ ...draft, accountHolder: e.target.value })} />
            <Input label="IBAN" value={draft.iban}
              onChange={(e) => setDraft({ ...draft, iban: e.target.value })} />
            <Input label="BIC" value={draft.bic}
              onChange={(e) => setDraft({ ...draft, bic: e.target.value })} />
            <Input label={t('businessProfile.bank.currency', 'Currency') as string} value={draft.currency}
              maxLength={3} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
            <label className="flex items-center gap-2 text-sm pt-6">
              <input type="checkbox" checked={draft.isDefault}
                onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />
              {t('businessProfile.bank.isDefault', 'Default for this currency')}
            </label>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <Button variant="outline" size="sm" onClick={() => setAdding(false)}>{t('common.cancel', 'Cancel')}</Button>
            <Button size="sm" onClick={() => create.mutate()} disabled={!draft.iban || create.isPending}>
              {t('common.save', 'Save')}
            </Button>
          </div>
        </div>
      )}

      {accounts.length === 0 ? (
        <p className="text-sm text-neutral-500">{t('businessProfile.noBanks', 'No bank accounts configured yet.')}</p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {accounts.map((b) => (
            <li key={b.id} className="py-2 flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">{b.label || b.iban}
                  {b.isDefault && <Star className="inline w-4 h-4 ml-1 text-amber-500" />}
                </div>
                <div className="text-xs text-neutral-500 font-mono">{b.iban.replace(/(.{4})/g, '$1 ').trim()}{b.currency ? ` · ${b.currency}` : ''}</div>
              </div>
              <div className="flex gap-2">
                {!b.isDefault && (
                  <Button variant="outline" size="sm" onClick={() => setDefault.mutate(b.id)}>
                    {t('businessProfile.bank.makeDefault', 'Make default')}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => {
                  if (window.confirm(t('businessProfile.bank.confirmDelete', 'Remove this bank account?'))) remove.mutate(b.id);
                }}>
                  <Trash2 className="w-4 h-4 text-red-600" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

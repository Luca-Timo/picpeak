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
import { Plus, Trash2, Star, Pencil, Save } from 'lucide-react';
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
        <Button
          onClick={() => saveProfile.mutate()}
          disabled={saveProfile.isPending}
          isLoading={saveProfile.isPending}
          leftIcon={<Save className="w-4 h-4" />}
        >
          {t('common.save', 'Save')}
        </Button>
      </div>

      <Card>
        <h3 className="font-semibold mb-3">{t('businessProfile.section.company', 'Company')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('businessProfile.field.companyName', 'Company name') as string} value={profile.companyName}
            onChange={(e) => setProfile({ ...profile, companyName: e.target.value })} />
          <Input label={t('businessProfile.field.vatId', 'VAT ID (USt-IdNr.)') as string} value={profile.vatId}
            onChange={(e) => setProfile({ ...profile, vatId: e.target.value })} />
          {/* Migration 139 — Steuernummer. Distinct from VAT-ID. §14
              UStG requires one or both on every invoice; many
              Kleinunternehmer (§19 UStG) only have this. */}
          <Input label={t('businessProfile.field.taxId', 'Tax number (Steuernummer)') as string}
            value={profile.taxId}
            onChange={(e) => setProfile({ ...profile, taxId: e.target.value })} />
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
          <Input label={t('businessProfile.field.countryCode', 'Country abbreviation (FL, CH, DE …)') as string}
            value={profile.countryCode}
            maxLength={2}
            placeholder="FL"
            onChange={(e) => setProfile({ ...profile, countryCode: e.target.value.toUpperCase() })} />
          {/* Free-text country name override (migration 107). When
              left empty the renderer falls back to the COUNTRY_NAMES
              lookup on the abbreviation. */}
          <Input label={t('businessProfile.field.countryName', 'Country (full name)') as string}
            value={profile.countryName || ''}
            placeholder="Liechtenstein"
            onChange={(e) => setProfile({ ...profile, countryName: e.target.value })} />
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
          {/* Migration 137 — IANA timezone string for the admin calendar.
              Free-text; backend caps at 64 chars. When blank the calendar
              UI falls back to the browser's `Intl.DateTimeFormat()
              .resolvedOptions().timeZone`. */}
          <Input
            label={t('businessProfile.field.timezone', 'Timezone (IANA)') as string}
            value={profile.timezone || ''}
            maxLength={64}
            placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
            onChange={(e) => setProfile({ ...profile, timezone: e.target.value || null })}
          />
          <Input label={t('businessProfile.field.vatLabel', 'VAT label (e.g. MwSt., VAT)') as string} value={profile.vatLabel}
            onChange={(e) => setProfile({ ...profile, vatLabel: e.target.value })} />
          <Input type="number" step="0.01" label={t('businessProfile.field.vatRateDefault', 'Default VAT rate %') as string}
            value={profile.vatRateDefault ?? 0}
            onChange={(e) => setProfile({ ...profile, vatRateDefault: Number(e.target.value) })} />
          <div>
            <label className="block text-sm font-medium mb-1">{t('businessProfile.field.defaultQrFormat', 'Default invoice QR')}</label>
            <select value={profile.defaultQrFormat} onChange={(e) => setProfile({ ...profile, defaultQrFormat: e.target.value as QrFormat })}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option value="none">{t('businessProfile.qrFormat.none', 'None')}</option>
              <option value="swiss">{t('businessProfile.qrFormat.swiss', 'Swiss QR-bill (CH / LI)')}</option>
              <option value="epc">{t('businessProfile.qrFormat.epc', 'EPC QR (SEPA / EUR)')}</option>
            </select>
          </div>
          <Input label={t('businessProfile.field.footerLine', 'PDF footer line') as string} value={profile.footerLine}
            onChange={(e) => setProfile({ ...profile, footerLine: e.target.value })} />
          {/* Dedicated PDF letterhead logo — separate from the global
              Settings → Branding logo. SVG accepted (rasterised to PNG
              on the fly). When unset the renderer falls back to the
              branding logo. */}
          <div className="md:col-span-2">
            <PdfLogoUploader profile={profile} setProfile={setProfile} />
          </div>
          {/* Logo banner height (pt) — admin-adjustable per migration 108. */}
          <Input type="number" min={24} max={200}
            label={t('businessProfile.field.pdfLogoHeight', 'PDF logo height (pt, 24-200)') as string}
            value={profile.pdfLogoHeight ?? 56}
            onChange={(e) => setProfile({ ...profile, pdfLogoHeight: Number(e.target.value) })} />
          {/* Folding marks dropdown. */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('businessProfile.field.pdfFoldingMarks', 'Folding marks on PDF page edge')}
            </label>
            <select value={profile.pdfFoldingMarks || 'none'}
              onChange={(e) => setProfile({ ...profile, pdfFoldingMarks: e.target.value as any })}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option value="none">{t('businessProfile.foldingMarks.none', 'None')}</option>
              <option value="half">{t('businessProfile.foldingMarks.half', 'Half (148.5mm) — for C5 envelopes')}</option>
              <option value="third">{t('businessProfile.foldingMarks.third', 'Thirds (105 + 210mm) — for DL / DIN long envelopes')}</option>
              <option value="both">{t('businessProfile.foldingMarks.both', 'All three marks')}</option>
            </select>
          </div>
          {/* PDF font selection lives on Settings → Branding now
              (migration 121, "PDF typography" card). The legacy
              free-text TTF path input was retired in favour of the
              bundled-fonts dropdown there. The column
              `pdf_font_ttf_path` stays on the row as a power-user
              override that the PDF renderer still honours when
              populated directly in the DB. */}
        </div>

        {/* PDF letterhead visibility toggles — let the admin suppress
            the logo or the company-name line independently. Useful
            when the logo itself already contains the brand name
            (very common with wordmark logos). Lifted out of the input
            grid so the toggle switches don't fight the field sizing. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 space-y-3">
          <PdfToggleRow
            label={t('businessProfile.field.pdfShowLogo', 'Show logo in PDF letterhead') as string}
            description={t('businessProfile.field.pdfShowLogoHelp',
              'When off, the logo image is suppressed on every PDF even if a logo is uploaded.') as string}
            enabled={profile.pdfShowLogo}
            onChange={(v) => setProfile({ ...profile, pdfShowLogo: v })}
          />
          <PdfToggleRow
            label={t('businessProfile.field.pdfShowCompanyName', 'Show company name in PDF letterhead') as string}
            description={t('businessProfile.field.pdfShowCompanyNameHelp',
              'When off, the company-name line is suppressed (useful if the logo is a wordmark already containing the name).') as string}
            enabled={profile.pdfShowCompanyName}
            onChange={(v) => setProfile({ ...profile, pdfShowCompanyName: v })}
          />
          <PdfToggleRow
            label={t('businessProfile.field.pdfCompanyNameInline', 'Render company name inline with address') as string}
            description={t('businessProfile.field.pdfCompanyNameInlineHelp',
              'When on, the company name appears as a plain line directly above the street address (same size + weight). When off, it renders as a bold title under the logo.') as string}
            enabled={profile.pdfCompanyNameInline}
            onChange={(v) => setProfile({ ...profile, pdfCompanyNameInline: v })}
          />
          {/* Quote payment-block toggles (migration 110). Both default
              OFF — a quote is an offer, not a demand for payment, and
              the IBAN block is always invoice-only. Admins opt in when
              they want to set payment expectations on the quote. */}
          <PdfToggleRow
            label={t('businessProfile.field.pdfQuoteShowNetDays', 'Show net payment days on quote PDFs') as string}
            description={t('businessProfile.field.pdfQuoteShowNetDaysHelp',
              'When on, quote PDFs include the "X days from invoice date." line in the payment conditions block. Invoices always show this row regardless.') as string}
            enabled={profile.pdfQuoteShowNetDays}
            onChange={(v) => setProfile({ ...profile, pdfQuoteShowNetDays: v })}
          />
          <PdfToggleRow
            label={t('businessProfile.field.pdfQuoteShowSkonto', 'Show Skonto / early-payment discount on quote PDFs') as string}
            description={t('businessProfile.field.pdfQuoteShowSkontoHelp',
              'When on, quote PDFs include the Skonto offer and the "Amount with discount" line. Invoices always show these regardless.') as string}
            enabled={profile.pdfQuoteShowSkonto}
            onChange={(v) => setProfile({ ...profile, pdfQuoteShowSkonto: v })}
          />
        </div>
      </Card>

      {/* Disclaimer banner for QR-bill / IBAN data. picpeak renders
          what the operator types — it cannot validate IBAN/BIC, QR-IID
          or scan-compatibility with any specific bank's e-banking app.
          See docs/crm-disclaimers.md. */}
      <div className="mt-4 p-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200">
        <p className="font-medium mb-1">
          {t('businessProfile.qrDisclaimer.title', 'QR-bill / bank data — verify before going live')}
        </p>
        <p className="text-xs">
          {t(
            'businessProfile.qrDisclaimer.body',
            "Picpeak is open source. We render the QR code and IBAN block from the values you typed — we don't validate them. Print a test invoice and scan it with your bank's app before sending real invoices. We are not responsible for any mistakes that come from sending an invoice with bad data on it.",
          )}
        </p>
      </div>

      <BankAccountsSection accounts={data?.bankAccounts ?? []} />
    </div>
  );
};

/**
 * Toggle row used for the PDF letterhead visibility options. Same
 * accessible-switch markup as the customer feature toggles on
 * CustomerDetailPage so the styling is consistent across the admin.
 */
interface PdfToggleRowProps {
  label: string;
  description?: string;
  enabled: boolean;
  onChange: (next: boolean) => void;
}

const PdfToggleRow: React.FC<PdfToggleRowProps> = ({ label, description, enabled, onChange }) => (
  <label className="flex items-center justify-between gap-4 cursor-pointer">
    <span className="text-sm">
      <span className="font-medium text-neutral-900 dark:text-neutral-100">{label}</span>
      {description && (
        <span className="block text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{description}</span>
      )}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 shrink-0"
      style={{ backgroundColor: enabled ? 'var(--color-accent)' : 'var(--color-surface-border)' }}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  </label>
);

/**
 * Dedicated PDF letterhead logo uploader. Accepts PNG / JPEG / SVG;
 * the backend rasterises SVG to PNG via sharp so vector uploads work
 * in print. Stores the relative path on business_profile.logo_path.
 */
interface PdfLogoUploaderProps {
  profile: BusinessProfile;
  setProfile: (next: BusinessProfile) => void;
}
const PdfLogoUploader: React.FC<PdfLogoUploaderProps> = ({ profile, setProfile }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { logoPath } = await businessProfileService.uploadLogo(file);
      setProfile({ ...profile, logoPath });
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      toast.success(t('businessProfile.logoUploadedToast', 'PDF logo uploaded.'));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onClear = async () => {
    if (!window.confirm(t('businessProfile.logoConfirmClear', 'Remove the PDF logo? The renderer will fall back to the Branding logo if one is set.'))) return;
    setUploading(true);
    try {
      await businessProfileService.clearLogo();
      setProfile({ ...profile, logoPath: '' });
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      toast.success(t('businessProfile.logoClearedToast', 'PDF logo removed.'));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Clear failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        {t('businessProfile.field.pdfLogoUpload', 'PDF letterhead logo (PNG, JPEG, or SVG)')}
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml"
          onChange={onPick}
          disabled={uploading}
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-primary-700 disabled:opacity-60"
        />
        {profile.logoPath && (
          <>
            <span className="text-xs text-neutral-500 font-mono break-all">{profile.logoPath}</span>
            <Button variant="outline" size="sm" onClick={onClear} disabled={uploading}>
              {t('common.remove', 'Remove')}
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-neutral-500 mt-1">
        {t('businessProfile.field.pdfLogoUploadHelp',
          'Used on every quote and invoice PDF. SVG is accepted and rasterised to PNG automatically. When empty, the renderer falls back to the global Branding logo.')}
      </p>
    </div>
  );
};

interface BankAccountsSectionProps { accounts: BankAccount[] }

type BankDraft = {
  label: string;
  accountHolder: string;
  iban: string;
  bic: string;
  currency: string;
  isDefault: boolean;
};

const EMPTY_DRAFT: BankDraft = {
  label: '', accountHolder: '', iban: '', bic: '', currency: 'CHF', isDefault: false,
};

const BankAccountsSection: React.FC<BankAccountsSectionProps> = ({ accounts }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // null = no form open; 'new' = adding; numeric id = editing that row.
  // Single piece of state means only one form is open at a time, which
  // is what the maintainer asked for: Add OR Edit, never both.
  const [openForm, setOpenForm] = useState<null | 'new' | number>(null);
  const [draft, setDraft] = useState<BankDraft>(EMPTY_DRAFT);

  const startEdit = (a: BankAccount) => {
    setDraft({
      label: a.label || '',
      accountHolder: a.accountHolder || '',
      iban: a.iban || '',
      bic: a.bic || '',
      currency: a.currency || 'CHF',
      isDefault: !!a.isDefault,
    });
    setOpenForm(a.id);
  };
  const closeForm = () => { setOpenForm(null); setDraft(EMPTY_DRAFT); };

  const create = useMutation({
    mutationFn: () => businessProfileService.createBankAccount(draft),
    onSuccess: () => {
      toast.success(t('businessProfile.bankCreatedToast', 'Bank account added.'));
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      closeForm();
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed'),
  });

  const update = useMutation({
    mutationFn: (id: number) => businessProfileService.updateBankAccount(id, draft),
    onSuccess: () => {
      toast.success(t('businessProfile.bankUpdatedToast', 'Bank account updated.'));
      qc.invalidateQueries({ queryKey: ['business-profile'] });
      closeForm();
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

  // Form body reused for both Add and Edit (single source of layout).
  const renderForm = (mode: 'new' | 'edit', onSubmit: () => void, submitting: boolean) => (
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
        <Button variant="outline" size="sm" onClick={closeForm}>{t('common.cancel', 'Cancel')}</Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!draft.iban || submitting}
          isLoading={submitting}
          leftIcon={mode === 'new' ? <Plus className="w-4 h-4" /> : <Save className="w-4 h-4" />}
        >
          {mode === 'new' ? t('common.add', 'Add') : t('common.save', 'Save')}
        </Button>
      </div>
    </div>
  );

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{t('businessProfile.section.banks', 'Bank accounts')}</h3>
        <Button size="sm" onClick={() => {
          if (openForm === 'new') closeForm();
          else { setDraft(EMPTY_DRAFT); setOpenForm('new'); }
        }}>
          <Plus className="w-4 h-4 mr-1" />{t('businessProfile.addBank', 'Add account')}
        </Button>
      </div>

      {openForm === 'new' && renderForm('new', () => create.mutate(), create.isPending)}

      {accounts.length === 0 ? (
        <p className="text-sm text-neutral-500">{t('businessProfile.noBanks', 'No bank accounts configured yet.')}</p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {accounts.map((b) => (
            <React.Fragment key={b.id}>
              <li className="py-2 flex items-center justify-between">
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
                    if (openForm === b.id) closeForm();
                    else startEdit(b);
                  }}
                    title={t('common.edit', 'Edit') as string}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    if (window.confirm(t('businessProfile.bank.confirmDelete', 'Remove this bank account?'))) remove.mutate(b.id);
                  }}
                    title={t('common.delete', 'Delete') as string}>
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </Button>
                </div>
              </li>
              {openForm === b.id && (
                <li className="py-2">
                  {renderForm('edit', () => update.mutate(b.id), update.isPending)}
                </li>
              )}
            </React.Fragment>
          ))}
        </ul>
      )}
    </Card>
  );
};

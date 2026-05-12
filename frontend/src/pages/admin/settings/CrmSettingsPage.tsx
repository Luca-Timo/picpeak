/**
 * Settings → CRM tab.
 *
 * Per-feature toggles that fine-tune the CRM behaviour without turning
 * off the whole `quotes` / `bills` global flag.  Backed by the
 * crm_* settings seeded by migration 102.  Reads via the generic
 * settings.service; writes one key at a time to keep blast radius small.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save as SaveIcon } from 'lucide-react';
import { Button, Card, Loading, Input } from '../../../components/common';
import { settingsService } from '../../../services/settings.service';
import { toast } from 'react-toastify';

const SETTING_KEYS = [
  'crm_quotes_pdf_attachment_enabled',
  'crm_quotes_skonto_enabled',
  'crm_quotes_accept_window_minutes',
  'crm_quotes_default_valid_days',
  'crm_quotes_number_format',
  'crm_invoices_qr_enabled',
  'crm_invoices_reminders_enabled',
  'crm_invoices_reminder_first_days',
  'crm_invoices_reminder_second_days',
  'crm_invoices_late_fee_enabled',
  'crm_invoices_late_fee_minor',
  'crm_invoices_late_fee_label',
  'crm_invoices_skonto_business_days',
  'crm_invoices_number_format',
];

export const CrmSettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'crm'],
    queryFn: async () => {
      const all = await settingsService.getAllSettings();
      const out: Record<string, any> = {};
      for (const key of SETTING_KEYS) out[key] = all[key];
      return out;
    },
  });

  const [values, setValues] = useState<Record<string, any>>({});
  useEffect(() => { if (data) setValues(data); }, [data]);

  const saveAll = useMutation({
    mutationFn: async () => {
      const changed: Record<string, any> = {};
      for (const key of SETTING_KEYS) {
        if (values[key] !== data?.[key]) changed[key] = values[key];
      }
      if (Object.keys(changed).length > 0) {
        await settingsService.updateSettings(changed);
      }
    },
    onSuccess: () => {
      toast.success(t('crmSettings.savedToast', 'CRM settings saved.'));
      qc.invalidateQueries({ queryKey: ['settings', 'crm'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || 'Save failed'),
  });

  if (isLoading) return <Loading />;

  const setVal = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));
  const checkbox = (k: string, label: string) => (
    <label className="flex items-center gap-2 text-sm py-1">
      <input type="checkbox" checked={!!values[k]} onChange={(e) => setVal(k, e.target.checked)} />
      <span>{t(`crmSettings.${k}.label`, label)}</span>
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{t('crmSettings.title', 'CRM settings')}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('crmSettings.subtitle', 'Fine-tune quote and invoice behaviour.')}
          </p>
        </div>
        <Button onClick={() => saveAll.mutate()} disabled={saveAll.isPending}>
          <SaveIcon className="w-4 h-4 mr-1" />{t('common.save', 'Save')}
        </Button>
      </div>

      <Card>
        <h3 className="font-semibold mb-3">{t('crmSettings.section.quotes', 'Quotes')}</h3>
        {checkbox('crm_quotes_pdf_attachment_enabled', 'Attach quote PDF to email')}
        {checkbox('crm_quotes_skonto_enabled', 'Allow early-payment discount (Skonto) on quotes')}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <Input type="number" min={1} max={120}
            label={t('crmSettings.crm_quotes_accept_window_minutes.label', 'Accept window (minutes)') as string}
            value={values.crm_quotes_accept_window_minutes ?? 15}
            onChange={(e) => setVal('crm_quotes_accept_window_minutes', Number(e.target.value))} />
          <Input type="number" min={1} max={365}
            label={t('crmSettings.crm_quotes_default_valid_days.label', 'Default validity (days)') as string}
            value={values.crm_quotes_default_valid_days ?? 30}
            onChange={(e) => setVal('crm_quotes_default_valid_days', Number(e.target.value))} />
          <Input
            label={t('crmSettings.crm_quotes_number_format.label', 'Quote number format') as string}
            value={values.crm_quotes_number_format ?? ''}
            onChange={(e) => setVal('crm_quotes_number_format', e.target.value)} />
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('crmSettings.section.invoices', 'Invoices')}</h3>
        {checkbox('crm_invoices_qr_enabled', 'Render payment QR on invoice PDFs')}
        {checkbox('crm_invoices_reminders_enabled', 'Send automatic reminders for overdue invoices')}
        {checkbox('crm_invoices_late_fee_enabled', 'Add a late fee on the second reminder')}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <Input type="number" min={1} max={365}
            label={t('crmSettings.crm_invoices_reminder_first_days.label', 'First reminder after (days past due)') as string}
            value={values.crm_invoices_reminder_first_days ?? 14}
            onChange={(e) => setVal('crm_invoices_reminder_first_days', Number(e.target.value))} />
          <Input type="number" min={1} max={365}
            label={t('crmSettings.crm_invoices_reminder_second_days.label', 'Second reminder after (days past due)') as string}
            value={values.crm_invoices_reminder_second_days ?? 30}
            onChange={(e) => setVal('crm_invoices_reminder_second_days', Number(e.target.value))} />
          <Input type="number" min={0}
            label={t('crmSettings.crm_invoices_late_fee_minor.label', 'Late fee (minor units / Rappen)') as string}
            value={values.crm_invoices_late_fee_minor ?? 0}
            onChange={(e) => setVal('crm_invoices_late_fee_minor', Number(e.target.value))} />
          <Input
            label={t('crmSettings.crm_invoices_late_fee_label.label', 'Late fee label') as string}
            value={values.crm_invoices_late_fee_label ?? 'Mahngebühr'}
            onChange={(e) => setVal('crm_invoices_late_fee_label', e.target.value)} />
          <Input type="number" min={0}
            label={t('crmSettings.crm_invoices_skonto_business_days.label', 'Skonto window (business days)') as string}
            value={values.crm_invoices_skonto_business_days ?? 5}
            onChange={(e) => setVal('crm_invoices_skonto_business_days', Number(e.target.value))} />
          <Input
            label={t('crmSettings.crm_invoices_number_format.label', 'Invoice number format') as string}
            value={values.crm_invoices_number_format ?? ''}
            onChange={(e) => setVal('crm_invoices_number_format', e.target.value)} />
        </div>
      </Card>
    </div>
  );
};

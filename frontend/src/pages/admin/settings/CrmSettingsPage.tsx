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
import { quotesService } from '../../../services/quotes.service';
import { toast } from 'react-toastify';

const SETTING_KEYS = [
  'crm_quotes_pdf_attachment_enabled',
  'crm_quotes_skonto_enabled',
  'crm_quotes_accept_window_minutes',
  'crm_quotes_default_valid_days',
  'crm_quotes_number_format',
  // Terms of Service step on quote acceptance (migration 104).
  'crm_quotes_tos_required',
  'crm_quotes_tos_text',
  'crm_quotes_tos_url',
  'crm_invoices_qr_enabled',
  'crm_invoices_reminders_enabled',
  'crm_invoices_reminder_first_days',
  'crm_invoices_reminder_second_days',
  'crm_invoices_late_fee_enabled',
  'crm_invoices_late_fee_minor',
  'crm_invoices_late_fee_label',
  'crm_invoices_skonto_business_days',
  'crm_invoices_skonto_percent_default',
  'crm_invoices_number_format',
  // Default Net days + Payment timing pickers (migration 124+125).
  // The per-quote/per-invoice picker becomes a true override over
  // these global defaults — the editor reads these on new documents.
  'crm_invoices_default_payment_net_days_template_id',
  'crm_invoices_default_payment_timing_template_id',
  // Contracts (migration 130). Number format token convention matches
  // quotes/invoices: {YEAR} {MONTH} {SEQ:04d}. Default 'C-{YEAR}-{SEQ:04d}'.
  'crm_contracts_number_format',
  'crm_contracts_default_valid_days',
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

  // Migration 124 — list the split-picker templates so the new
  // dropdowns can render labels. Same endpoints the editors use.
  const { data: netDaysTemplates } = useQuery({
    queryKey: ['payment-net-days-templates'],
    queryFn: () => quotesService.listPaymentNetDaysTemplates(),
  });
  const { data: timingTemplates } = useQuery({
    queryKey: ['payment-timing-templates'],
    queryFn: () => quotesService.listPaymentTimingTemplates(),
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

        {/* Terms of Service step (migration 104). When required, the
            public quote response page shows a checkbox the customer
            must tick before Accept fires. The text snapshot is
            recorded on the quote at acceptance time for audit. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <h4 className="font-semibold mb-2 text-sm">
            {t('crmSettings.section.quotesTos', 'Terms of Service / AGB step')}
          </h4>
          {checkbox('crm_quotes_tos_required', 'Require customers to tick "I accept the Terms of Service" before accepting')}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <Input
              label={t('crmSettings.crm_quotes_tos_url.label', 'Terms of Service URL (optional)') as string}
              placeholder="https://example.com/terms"
              value={values.crm_quotes_tos_url ?? ''}
              onChange={(e) => setVal('crm_quotes_tos_url', e.target.value)} />
          </div>
          <div className="mt-3">
            <label className="block text-sm font-medium mb-1">
              {t('crmSettings.crm_quotes_tos_text.label', 'Inline Terms text shown on the quote page')}
            </label>
            <textarea
              rows={6}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              value={values.crm_quotes_tos_text ?? ''}
              onChange={(e) => setVal('crm_quotes_tos_text', e.target.value)}
              placeholder={t('crmSettings.crm_quotes_tos_text.placeholder',
                'Paste the contract terms here. Plain text. Leave empty to only show the checkbox + URL.') as string}
            />
          </div>
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
          <Input type="number" min={0} step="0.01" max="100"
            label={t('crmSettings.crm_invoices_skonto_percent_default.label', 'Skonto rate (default %)') as string}
            value={values.crm_invoices_skonto_percent_default ?? 2}
            onChange={(e) => setVal('crm_invoices_skonto_percent_default', Number(e.target.value))} />
          <Input type="number" min={0}
            label={t('crmSettings.crm_invoices_skonto_business_days.label', 'Skonto window (business days)') as string}
            value={values.crm_invoices_skonto_business_days ?? 5}
            onChange={(e) => setVal('crm_invoices_skonto_business_days', Number(e.target.value))} />
          <Input
            label={t('crmSettings.crm_invoices_number_format.label', 'Invoice number format') as string}
            value={values.crm_invoices_number_format ?? ''}
            onChange={(e) => setVal('crm_invoices_number_format', e.target.value)} />
        </div>

        {/* Default payment-term pickers (migration 124+125). The
            per-quote / per-invoice editor still always shows the
            pickers — admin can override per document — but new
            drafts auto-prefill from these two settings. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <h4 className="font-semibold mb-2 text-sm">
            {t('crmSettings.section.paymentDefaults', 'Default payment conditions')}
          </h4>
          <p className="text-xs text-neutral-500 mb-3">
            {t('crmSettings.paymentDefaults.help',
              'Pre-filled on every new quote and invoice. The editor still lets you pick a different combination per document.')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('crmSettings.crm_invoices_default_payment_net_days_template_id.label', 'Default net days')}
              </label>
              <select
                className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                value={values.crm_invoices_default_payment_net_days_template_id ?? ''}
                onChange={(e) => setVal('crm_invoices_default_payment_net_days_template_id', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t('crmSettings.paymentDefaults.none', '— No default —')}</option>
                {netDaysTemplates?.templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('crmSettings.crm_invoices_default_payment_timing_template_id.label', 'Default payment schedule')}
              </label>
              <select
                className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                value={values.crm_invoices_default_payment_timing_template_id ?? ''}
                onChange={(e) => setVal('crm_invoices_default_payment_timing_template_id', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t('crmSettings.paymentDefaults.none', '— No default —')}</option>
                {timingTemplates?.templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Contracts (migration 130) — number format follows the same
            {YEAR}/{MONTH}/{SEQ:04d} token convention as quotes/invoices.
            Default 'C-{YEAR}-{SEQ:04d}' covers most needs; admins who
            prefix with their own initials (e.g. 'LBM-C-{YEAR}-{SEQ:04d}')
            edit it here. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <h4 className="font-semibold mb-2 text-sm">
            {t('crmSettings.section.contracts', 'Contracts')}
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              label={t('crmSettings.crm_contracts_number_format.label', 'Contract number format') as string}
              value={values.crm_contracts_number_format ?? ''}
              onChange={(e) => setVal('crm_contracts_number_format', e.target.value)}
              placeholder="C-{YEAR}-{SEQ:04d}"
            />
            <Input type="number" min={1}
              label={t('crmSettings.crm_contracts_default_valid_days.label', 'Signing window (days)') as string}
              value={values.crm_contracts_default_valid_days ?? 30}
              onChange={(e) => setVal('crm_contracts_default_valid_days', Number(e.target.value))} />
          </div>
          <p className="text-xs text-neutral-500 mt-2">
            {t('crmSettings.crm_contracts_number_format.help',
              'Supported tokens: {YEAR}, {MONTH}, {SEQ:04d}. Example: LBM-C-{YEAR}-{SEQ:04d} → LBM-C-2026-0001.')}
          </p>
        </div>
      </Card>
    </div>
  );
};

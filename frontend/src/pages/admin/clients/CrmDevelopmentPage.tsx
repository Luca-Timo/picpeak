/**
 * CRM → Development sub-page.
 *
 * Houses internal-use dev tools for the CRM area. Hidden behind the
 * `crmDevelopment` feature flag (Settings → Features) so it stays
 * invisible on customer installs.
 *
 * Current tools:
 *   - "Test admin payment-check email" — fires the full
 *     payment-check email flow on any sent/overdue invoice, bypassing
 *     the 24h throttle so the maintainer can verify the
 *     email → token page → action recorded chain in seconds.
 *
 * Future tools (sketched as TODOs in the code below) can dock here
 * — every entry stays gated by the same flag so the page is the one
 *  place to look for "weird internal buttons".
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Wrench, MailCheck, AlertTriangle } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { billsService, type InvoiceStatus } from '../../../services/bills.service';
import { toast } from 'react-toastify';

export const CrmDevelopmentPage: React.FC = () => {
  const { t } = useTranslation();

  // Only sent/overdue invoices can carry a payment-check token. We
  // load the most recent 50 so the picker is fast — the test action
  // is local-only and rarely fired against bulk lists.
  const { data, isLoading } = useQuery({
    queryKey: ['invoices', 'dev-payment-check'],
    queryFn: () => billsService.list({
      status: ['sent', 'overdue'] as InvoiceStatus[],
      sort: 'newest',
      pageSize: 50,
    }),
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSend = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const res = await billsService.testPaymentCheck(selectedId);
      toast.success(t('crmDev.paymentCheck.sentToast',
        'Test email queued. Check the recipient\'s inbox. Token: {{token}}',
        { token: (res as any).token?.slice(0, 8) + '…' || '' }));
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to queue test email');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <Wrench className="w-5 h-5" />
          {t('crmDev.title', 'CRM Development')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('crmDev.subtitle',
            'Internal tools for verifying CRM flows. Hidden by default — enabled via Settings → Features → Development.')}
        </p>
      </div>

      <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 mb-5 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
        <p className="text-sm text-amber-800 dark:text-amber-200">
          {t('crmDev.warning',
            'These tools fire real side effects (emails, status changes). Use against test data.')}
        </p>
      </div>

      <Card>
        <h3 className="font-semibold mb-1 flex items-center gap-2">
          <MailCheck className="w-4 h-4" />
          {t('crmDev.paymentCheck.title', 'Test payment-check email')}
        </h3>
        <p className="text-sm text-muted-theme mb-4">
          {t('crmDev.paymentCheck.help',
            'Fires the admin payment-check email for the selected invoice immediately, bypassing the 24h throttle. The email contains the three buttons (Paid in full / Partial / Not paid) that link to the token-gated public page — exactly what the scheduler would send when an invoice ages past the reminder threshold.')}
        </p>

        {isLoading ? <Loading /> : (
          <>
            <label className="block text-xs uppercase tracking-wider text-muted-theme mb-1">
              {t('crmDev.paymentCheck.selectInvoice', 'Sent or overdue invoice')}
            </label>
            <select
              value={selectedId || ''}
              onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm mb-3"
            >
              <option value="">{t('crmDev.paymentCheck.selectPlaceholder', '— Pick an invoice —')}</option>
              {(data?.invoices || []).map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoiceNumber} · {inv.customer.companyName || inv.customer.displayName || inv.customer.email} · {inv.status}
                </option>
              ))}
            </select>
            {data && data.invoices.length === 0 && (
              <p className="text-sm text-muted-theme mb-3">
                {t('crmDev.paymentCheck.noneAvailable',
                  'No sent or overdue invoices in the database — only those can carry a payment-check token.')}
              </p>
            )}
            <div className="flex justify-end">
              <Button onClick={handleSend} disabled={!selectedId || busy}>
                <MailCheck className="w-4 h-4 mr-1" />
                {busy ? t('crmDev.paymentCheck.sending', 'Queuing…') : t('crmDev.paymentCheck.send', 'Send test email')}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* Drop future dev tools here — each one as its own <Card>. */}
    </div>
  );
};

export default CrmDevelopmentPage;

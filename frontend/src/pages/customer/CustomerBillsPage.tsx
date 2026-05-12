/**
 * Customer-side Invoices list. Read-only view of every invoice that
 * has been sent (or is overdue / paid). Scheduled drafts and
 * cancelled invoices are hidden server-side so the customer never
 * sees admin's in-progress work.
 *
 * Each row exposes a "View PDF" link that opens the rendered invoice
 * in a new tab via a popup-blocker-safe sync window.open.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Receipt, Download } from 'lucide-react';
import { customerService, type CustomerInvoice } from '../../services/customer.service';
import { Card, Loading } from '../../components/common';
import { toast } from 'react-toastify';

function formatMoney(amount: number, currency: string, locale = 'de-CH') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: (currency || 'CHF').toUpperCase() }).format(amount);
}
function formatShortDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export const CustomerBillsPage: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['customer-invoices'],
    queryFn: () => customerService.listInvoices(),
  });

  if (isLoading) return <Loading />;
  if (isError) {
    const status = (error as any)?.response?.status;
    if (status === 403) {
      return (
        <div className="container py-8">
          <h1 className="text-2xl font-bold mb-2">{t('customer.bills.title', 'Invoices')}</h1>
          <p className="text-muted-theme">
            {t('customer.bills.disabled',
              'This feature is currently disabled for your account. Please contact your photographer if you expected to see invoices here.')}
          </p>
        </div>
      );
    }
    return (
      <div className="container py-8">
        <p className="text-red-600">{t('customer.bills.loadError', 'Could not load invoices.')}</p>
      </div>
    );
  }
  const invoices = data || [];

  const handleViewPdf = async (inv: CustomerInvoice) => {
    // Sync-open the window so the popup blocker treats this as a
    // user gesture, then redirect to the blob URL once it's ready.
    const win = window.open('about:blank', '_blank');
    if (!win) {
      toast.error(t('customer.bills.popupBlocked', 'Allow pop-ups for this site to view the invoice PDF.'));
      return;
    }
    try {
      const url = await customerService.invoicePdfUrl(inv.id);
      win.location.href = url;
    } catch (err: any) {
      win.close();
      toast.error(err?.response?.data?.error || err.message || 'Failed to load invoice PDF');
    }
  };

  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme flex items-center gap-2">
          <Receipt className="w-6 h-6" />
          {t('customer.bills.title', 'Invoices')}
        </h1>
        <p className="text-sm text-muted-theme mt-1">
          {t('customer.bills.subtitle',
            'Every invoice your photographer has sent you. Click "View PDF" to download.')}
        </p>
      </div>

      {invoices.length === 0 ? (
        <Card padding="lg">
          <p className="text-center text-muted-theme py-8">
            {t('customer.bills.empty', 'No invoices yet.')}
          </p>
        </Card>
      ) : (
        <Card padding="none">
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {invoices.map((inv) => (
              <InvoiceRow key={inv.id} inv={inv} onViewPdf={() => handleViewPdf(inv)} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
};

const InvoiceRow: React.FC<{ inv: CustomerInvoice; onViewPdf: () => void }> = ({ inv, onViewPdf }) => {
  const { t } = useTranslation();
  const total = Number(inv.totalAmountMinor || 0) / 100;
  const lateFee = Number(inv.lateFeeAmountMinor || 0) / 100;
  const paid = Number(inv.paidAmountMinor || 0) / 100;
  const outstanding = Math.max(0, total - paid);

  const statusClass =
    inv.status === 'paid' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
    : inv.status === 'overdue' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm">{inv.invoiceNumber}</span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusClass}`}>
              {t(`bills.status.${inv.status}`, inv.status)}
            </span>
            {inv.installmentTotal > 1 && (
              <span className="text-xs text-muted-theme">
                {inv.installmentIndex + 1}/{inv.installmentTotal}
                {inv.installmentLabel ? ` · ${inv.installmentLabel}` : ''}
              </span>
            )}
          </div>
          <div className="text-sm text-muted-theme mt-1">
            {t('customer.bills.field.issueDate', 'Issued')}: {formatShortDate(inv.issueDate)}
            {' · '}
            {t('customer.bills.field.dueDate', 'Due')}: {formatShortDate(inv.dueDate)}
            {inv.paidAt && (
              <> {' · '} {t('customer.bills.field.paidAt', 'Paid')}: {formatShortDate(inv.paidAt)}</>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="font-medium tabular-nums">{formatMoney(total, inv.currency)}</div>
          {outstanding > 0 && (
            <div className="text-xs text-red-700 dark:text-red-400 mt-0.5">
              {t('customer.bills.field.outstanding', 'Outstanding')}: {formatMoney(outstanding, inv.currency)}
            </div>
          )}
          {lateFee > 0 && (
            <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {t('customer.bills.field.lateFee', 'Late fee')}: {formatMoney(lateFee, inv.currency)}
            </div>
          )}
          <button type="button" onClick={onViewPdf}
            className="text-xs text-primary-600 dark:text-primary-400 mt-1 inline-flex items-center gap-1 hover:underline">
            <Download className="w-3 h-3" />
            {t('customer.bills.viewPdf', 'View PDF')}
          </button>
        </div>
      </div>
    </li>
  );
};

export default CustomerBillsPage;

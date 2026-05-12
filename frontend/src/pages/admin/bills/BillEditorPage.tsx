/**
 * Invoice editor — create (manual) or edit. Most invoices come from
 * quote conversion; this page is for one-off / ad-hoc invoicing.
 * Smaller surface than the quote editor on purpose.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Save as SaveIcon } from 'lucide-react';
import { Button, Card, Loading, Input } from '../../../components/common';
import { billsService, type InvoiceCreatePayload, type InvoiceQrFormat } from '../../../services/bills.service';
import { LineItemsTable, type EditableLineItem } from '../../../components/admin/LineItemsTable';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { toast } from 'react-toastify';

function toMinor(amount: number) {
  return Math.round((Number(amount) || 0) * 100);
}

export const BillEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isEdit = id && id !== 'new';

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerLabel, setCustomerLabel] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [currency, setCurrency] = useState('CHF');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [scheduledSendAt, setScheduledSendAt] = useState('');
  const [qrFormat, setQrFormat] = useState<InvoiceQrFormat>('none');
  const [vatRate, setVatRate] = useState(0);
  const [shipping, setShipping] = useState(0);
  const [ccPdfEmail, setCcPdfEmail] = useState('');
  const [lineItems, setLineItems] = useState<EditableLineItem[]>([]);
  const [busy, setBusy] = useState(false);

  const { data: existing, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => billsService.get(parseInt(id!, 10)),
    enabled: !!isEdit,
  });

  useEffect(() => {
    if (existing) {
      const inv = existing.invoice;
      setCustomerId(inv.customerAccountId);
      setCustomerLabel(inv.customer.companyName || inv.customer.displayName || inv.customer.email || '');
      setCurrency(inv.currency);
      setIssueDate(inv.issueDate);
      setDueDate(inv.dueDate);
      setScheduledSendAt(inv.scheduledSendAt ? inv.scheduledSendAt.slice(0, 16) : '');
      setQrFormat((inv.qrFormat as InvoiceQrFormat) || 'none');
      setVatRate(Number(inv.vatRate || 0));
      setShipping(Number(inv.shippingAmountMinor || 0) / 100);
      setCcPdfEmail(inv.ccPdfEmail || '');
      setLineItems(existing.lineItems.map((li) => ({
        id: li.id,
        position: li.position,
        quantity: Number(li.quantity),
        description: li.description,
        unitPrice: Number(li.unitPriceMinor || 0) / 100,
        discountPercent: Number(li.discountPercent || 0),
      })));
    }
  }, [existing]);

  const { data: customerOptions } = useQuery({
    queryKey: ['customer-search', customerSearch],
    queryFn: () => customerAdminService.search(customerSearch),
    enabled: customerSearch.length >= 2,
  });

  const buildPayload = (): InvoiceCreatePayload => ({
    customerAccountId: customerId || 0,
    currency,
    issueDate,
    dueDate: dueDate || undefined,
    scheduledSendAt: scheduledSendAt || undefined,
    qrFormat,
    vatRate,
    shippingAmountMinor: toMinor(shipping),
    ccPdfEmail: ccPdfEmail || undefined,
    lineItems: lineItems.map((li) => ({
      position: li.position,
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: toMinor(li.unitPrice),
      discountPercent: li.discountPercent,
    })),
  });

  const handleSave = async (then?: 'preview') => {
    if (!customerId) { toast.error(t('bills.errors.customerRequired', 'Pick a customer first.')); return; }
    setBusy(true);
    try {
      const payload = buildPayload();
      const saved = isEdit
        ? await billsService.update(parseInt(id!, 10), payload)
        : await billsService.create(payload);
      qc.invalidateQueries({ queryKey: ['invoices'] });
      if (then === 'preview') {
        const url = await billsService.pdfUrl(saved.invoice.id);
        window.open(url, '_blank');
      } else {
        toast.success(t('bills.savedToast', 'Invoice saved.'));
      }
      navigate(`/admin/clients/bills/${saved.invoice.id}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err.message || 'Save failed');
    } finally { setBusy(false); }
  };

  const handlePreviewUnsaved = async () => {
    if (!customerId) { toast.error(t('bills.errors.customerRequired', 'Pick a customer first.')); return; }
    try {
      const url = await billsService.previewPdfUrl(buildPayload());
      window.open(url, '_blank');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Preview failed');
    }
  };

  if (isEdit && isLoading) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/admin/clients/bills')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold">{isEdit ? `${t('bills.edit', 'Edit invoice')} ${existing?.invoice.invoiceNumber || ''}` : t('bills.new', 'New invoice')}</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handlePreviewUnsaved} disabled={busy}>
            <Eye className="w-4 h-4 mr-1" />{t('common.preview', 'Preview')}
          </Button>
          <Button onClick={() => handleSave()} disabled={busy}>
            <SaveIcon className="w-4 h-4 mr-1" />{t('common.save', 'Save')}
          </Button>
        </div>
      </div>

      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.customer', 'Customer')}</h3>
        {customerId ? (
          <div className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-800 rounded-md px-3 py-2">
            <span className="text-sm">{customerLabel}</span>
            <Button variant="outline" size="sm" onClick={() => { setCustomerId(null); setCustomerLabel(''); }}>
              {t('common.change', 'Change')}
            </Button>
          </div>
        ) : (
          <>
            <Input placeholder={t('bills.customerSearch', 'Search by email or company…') as string}
              value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />
            {customerOptions && customerOptions.length > 0 && (
              <ul className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-700 divide-y divide-neutral-200 dark:divide-neutral-700">
                {customerOptions.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-sm"
                      onClick={() => { setCustomerId(c.id); setCustomerLabel(c.companyName || c.displayName || c.email); }}>
                      <span className="font-medium">{c.companyName || c.displayName || c.email}</span>
                      <span className="text-neutral-500 ml-2">{c.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.details', 'Details')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input type="date" label={t('bills.field.issueDate', 'Issue date') as string} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          <Input type="date" label={t('bills.field.dueDate', 'Due date') as string} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <Input type="datetime-local" label={t('bills.field.scheduledSendAt', 'Scheduled send (optional)') as string}
            value={scheduledSendAt} onChange={(e) => setScheduledSendAt(e.target.value)} />
          <div>
            <label className="block text-sm font-medium mb-1">{t('bills.field.qrFormat', 'Payment QR format')}</label>
            <select value={qrFormat} onChange={(e) => setQrFormat(e.target.value as InvoiceQrFormat)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option value="none">{t('bills.qrFormat.none', 'None')}</option>
              <option value="swiss">{t('bills.qrFormat.swiss', 'Swiss QR-bill')}</option>
              <option value="epc">{t('bills.qrFormat.epc', 'EPC QR (SEPA)')}</option>
            </select>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.lineItems', 'Line items')}</h3>
        <LineItemsTable items={lineItems} currency={currency} showDiscount={false}
          vatRate={vatRate / 100} shippingAmount={shipping} onChange={setLineItems} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <Input type="number" step="0.1" label={t('bills.field.vatRate', 'VAT rate %') as string}
            value={vatRate} onChange={(e) => setVatRate(Number(e.target.value))} />
          <Input type="number" step="0.01" label={t('bills.field.shipping', 'Shipping') as string}
            value={shipping} onChange={(e) => setShipping(Number(e.target.value))} />
          <div>
            <label className="block text-sm font-medium mb-1">{t('bills.field.currency', 'Currency')}</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option>CHF</option><option>EUR</option><option>USD</option><option>GBP</option>
            </select>
          </div>
        </div>
      </Card>

      <Card>
        <Input label={t('bills.field.ccPdfEmail', 'CC PDF to (extra recipient)') as string}
          value={ccPdfEmail} onChange={(e) => setCcPdfEmail(e.target.value)} />
      </Card>
    </div>
  );
};

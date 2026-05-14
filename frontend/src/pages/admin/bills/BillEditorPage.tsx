/**
 * Invoice editor — create (manual) or edit. Most invoices come from
 * quote conversion; this page is for one-off / ad-hoc invoicing.
 * Smaller surface than the quote editor on purpose.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Save as SaveIcon } from 'lucide-react';
import { Button, Card, Loading, Input } from '../../../components/common';
import { billsService, type InvoiceCreatePayload, type InvoiceQrFormat } from '../../../services/bills.service';
import { quotesService } from '../../../services/quotes.service';
import { LineItemsTable, type EditableLineItem } from '../../../components/admin/LineItemsTable';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { userManagementService } from '../../../services/userManagement.service';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import { toast } from 'react-toastify';

function toMinor(amount: number) {
  return Math.round((Number(amount) || 0) * 100);
}

export const BillEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
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
  // null = inherit profile default at render time. 'none' / 'swiss' /
  // 'epc' = explicit per-invoice override. (Existing invoices that
  // already have a value carry it through `setQrFormat` in the load
  // effect; new invoices start as null so they pick up profile.)
  const [qrFormat, setQrFormat] = useState<InvoiceQrFormat | null>(null);
  const [vatRate, setVatRate] = useState(0);
  const [shipping, setShipping] = useState(0);
  const [ccPdfEmail, setCcPdfEmail] = useState('');
  const [lineItems, setLineItems] = useState<EditableLineItem[]>([]);
  const [paymentTermTemplateId, setPaymentTermTemplateId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Payment-term templates shared with the quote editor — same
  // dropdown, same data source. Lets the admin pick net-days +
  // Skonto + installment plan when creating an invoice directly.
  const { data: ptTemplates } = useQuery({
    queryKey: ['payment-term-templates'],
    queryFn: () => quotesService.listPaymentTermTemplates(),
  });

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
      // Preserve null when the saved invoice has no explicit format —
      // it inherits the profile default at render time.
      setQrFormat((inv.qrFormat as InvoiceQrFormat | null) || null);
      setVatRate(Number(inv.vatRate || 0));
      setShipping(Number(inv.shippingAmountMinor || 0) / 100);
      setCcPdfEmail(inv.ccPdfEmail || '');
      setPaymentTermTemplateId(inv.paymentTermTemplateId ?? null);
      setLineItems(existing.lineItems.map((li) => ({
        id: li.id,
        position: li.position,
        quantity: Number(li.quantity),
        description: li.description,
        unitPrice: Number(li.unitPriceMinor || 0) / 100,
        discountPercent: Number(li.discountPercent || 0),
        parentPosition: li.parentPosition ?? null,
        detailsText: li.detailsText || '',
      })));
    }
  }, [existing]);

  // Admin auth + list — used to pre-fill + offer a dropdown for the
  // "CC PDF to" field (mirrors the QuoteEditorPage pattern + the
  // admin_email picker on CreateEventPage). Falls back to an empty
  // list silently if the current user lacks users.view permission so
  // basic admins still get the auto-prefill from currentAdmin.
  const { user: currentAdmin } = useAdminAuth();
  const { data: adminUsers } = useQuery({
    queryKey: ['admin-users-list'],
    queryFn: async () => {
      try { return await userManagementService.getUsers(); } catch { return []; }
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const activeAdmins = useMemo(
    () => (adminUsers || []).filter((u: any) => u.isActive !== false && !!u.email),
    [adminUsers]
  );

  // Pre-fill CC PDF email with the current admin's email on a brand-
  // new invoice. Skip on edit and don't clobber existing values.
  const didPrefillCcRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillCcRef.current) return;
    if (!currentAdmin?.email) return;
    didPrefillCcRef.current = true;
    setCcPdfEmail((cur) => cur || currentAdmin.email);
  }, [currentAdmin?.email, isEdit]);

  // Pre-fill the customer when the editor is opened from a customer
  // detail page via `?customerAccountId=42`. Runs once on mount, only
  // when creating a new invoice, and skips if the user has already
  // picked a customer.
  const didPrefillCustomerRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillCustomerRef.current) return;
    const raw = searchParams.get('customerAccountId');
    const cid = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(cid) || cid <= 0) return;
    didPrefillCustomerRef.current = true;
    (async () => {
      try {
        const c = await customerAdminService.get(cid);
        if (!customerId) {
          setCustomerId(c.id);
          setCustomerLabel(c.companyName || c.displayName || c.email);
        }
      } catch {
        // Silent fail — admin can still pick the customer manually.
      }
    })();
  }, [isEdit, searchParams, customerId]);

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
    // Omit when null so the server inherits the profile default;
    // including null would persist as an explicit "no preference"
    // which is the same outcome but pollutes the column.
    qrFormat: qrFormat || undefined,
    vatRate,
    shippingAmountMinor: toMinor(shipping),
    ccPdfEmail: ccPdfEmail || undefined,
    // Payment-term template id (migration 113). null = no template
    // selected; backend falls back to source-quote snapshot or the
    // global crm_invoices_* defaults.
    paymentTermTemplateId: paymentTermTemplateId ?? undefined,
    lineItems: lineItems.map((li) => ({
      position: li.position,
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: toMinor(li.unitPrice),
      discountPercent: li.discountPercent,
      // Migration 119 — sub-items + details survive save → reload.
      parentPosition: li.parentPosition ?? null,
      detailsText: li.detailsText || null,
    })),
  });

  const handleSave = async (then?: 'preview') => {
    if (!customerId) { toast.error(t('bills.errors.customerRequired', 'Pick a customer first.')); return; }
    // Open the preview tab synchronously so popup blockers don't kill
    // it (they reject any window.open that runs after an `await`).
    const previewWindow = then === 'preview' ? window.open('about:blank', '_blank') : null;
    if (then === 'preview' && !previewWindow) {
      toast.error(t('bills.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    setBusy(true);
    try {
      const payload = buildPayload();
      const saved = isEdit
        ? await billsService.update(parseInt(id!, 10), payload)
        : await billsService.create(payload);
      qc.invalidateQueries({ queryKey: ['invoices'] });
      if (then === 'preview') {
        const url = await billsService.pdfUrl(saved.invoice.id);
        if (previewWindow) previewWindow.location.href = url;
      } else {
        toast.success(t('bills.savedToast', 'Invoice saved.'));
      }
      navigate(`/admin/clients/bills/${saved.invoice.id}`);
    } catch (err: any) {
      if (previewWindow) previewWindow.close();
      toast.error(err?.response?.data?.error || err.message || 'Save failed');
    } finally { setBusy(false); }
  };

  const handlePreviewUnsaved = async () => {
    if (!customerId) { toast.error(t('bills.errors.customerRequired', 'Pick a customer first.')); return; }
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('bills.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    try {
      const url = await billsService.previewPdfUrl(buildPayload());
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
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
            <select
              value={qrFormat || ''}
              onChange={(e) => setQrFormat((e.target.value || null) as any)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              {/* Empty value = use the business-profile default. Server
                  resolves the actual format at render time, so admins
                  who curate it once in Settings → Business profile
                  never have to think about it per-invoice. */}
              <option value="">{t('bills.qrFormat.profileDefault', 'Use business profile default')}</option>
              <option value="none">{t('bills.qrFormat.none', 'None (override)')}</option>
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

      {/* Payment conditions — picks net-days + Skonto from the shared
          payment-term templates (same dropdown the quote editor uses).
          Optional: leave at "— Select —" to let the renderer fall back
          to the source quote's snapshot, or to the global
          crm_invoices_* defaults for ad-hoc invoices. */}
      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.payment', 'Payment conditions')}</h3>
        <select
          className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
          value={paymentTermTemplateId || ''}
          onChange={(e) => setPaymentTermTemplateId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">{t('bills.field.selectPaymentTerm', '— Select payment terms —')}</option>
          {ptTemplates?.templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
          ))}
        </select>
        <p className="text-xs text-neutral-500 mt-2">
          {t('bills.field.paymentTermHelp',
            'Net days + Skonto for this invoice. Leave blank to inherit from the source quote or the global CRM defaults.')}
        </p>
      </Card>

      <Card>
        {/* CC PDF — admin email prefilled, with a picker when more than
            one admin exists. Mirrors the quote editor + CreateEventPage
            so the muscle memory carries over. */}
        <div className="space-y-1">
          <Input type="email"
            label={t('bills.field.ccPdfEmail', 'CC PDF to (extra recipient)') as string}
            placeholder={t('bills.field.ccPdfEmailPlaceholder', 'name@example.com') as string}
            value={ccPdfEmail} onChange={(e) => setCcPdfEmail(e.target.value)} />
          {activeAdmins.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor="bill-cc-pdf-picker" className="text-xs text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                {t('bills.field.ccPdfPickFromAdmins', 'Pick from admins:')}
              </label>
              <select
                id="bill-cc-pdf-picker"
                value={activeAdmins.some((a: any) => a.email === ccPdfEmail) ? ccPdfEmail : ''}
                onChange={(e) => {
                  const email = e.target.value;
                  if (email) setCcPdfEmail(email);
                }}
                className="text-xs px-2 py-1 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              >
                <option value="">{t('bills.field.ccPdfCustom', 'Custom email')}</option>
                {activeAdmins.map((a: any) => (
                  <option key={a.id} value={a.email}>{a.email}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

/**
 * Quote editor — create or edit. Five sections:
 *  1. Customer
 *  2. Event data
 *  3. Line items (LineItemsTable)
 *  4. Payment conditions
 *  5. Intro/outro + CC PDF email + internal notes
 *
 * Send is a deliberate two-step action (confirm dialog) since it emails
 * the customer. Preview PDF is available before save (POST /preview)
 * and after save (GET /:id/pdf) for the "what does my customer see?"
 * check.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Send } from 'lucide-react';
import { Button, Card, Loading, Input } from '../../../components/common';
import {
  quotesService,
  type QuoteCreatePayload,
  type PaymentTermInstallment,
} from '../../../services/quotes.service';
import { LineItemsTable, type EditableLineItem } from '../../../components/admin/LineItemsTable';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { userManagementService } from '../../../services/userManagement.service';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import { toast } from 'react-toastify';

interface FormState {
  customerAccountId: number | null;
  customerLabel: string;
  language: string;
  currency: string;
  issueDate: string;
  validUntil: string;
  eventName: string;
  eventDate: string;
  eventTimeStart: string;
  eventTimeEnd: string;
  expectedDurationHours: string;
  paymentTermTemplateId: number | null;
  vatRate: number;
  shippingAmount: number;
  introText: string;
  outroText: string;
  internalNotes: string;
  ccPdfEmail: string;
  businessBankAccountId: number | null;
  lineItems: EditableLineItem[];
}

const empty: FormState = {
  customerAccountId: null,
  customerLabel: '',
  language: 'de',
  currency: 'CHF',
  issueDate: new Date().toISOString().slice(0, 10),
  validUntil: '',
  eventName: '',
  eventDate: '',
  eventTimeStart: '',
  eventTimeEnd: '',
  expectedDurationHours: '',
  paymentTermTemplateId: null,
  vatRate: 0,
  shippingAmount: 0,
  introText: '',
  outroText: '',
  internalNotes: '',
  ccPdfEmail: '',
  businessBankAccountId: null,
  lineItems: [],
};

function toMinor(amount: number) {
  return Math.round((Number(amount) || 0) * 100);
}

function buildPayload(f: FormState): QuoteCreatePayload {
  return {
    customerAccountId: f.customerAccountId || 0,
    language: f.language,
    currency: f.currency,
    issueDate: f.issueDate,
    validUntil: f.validUntil || undefined,
    eventName: f.eventName || undefined,
    eventDate: f.eventDate || undefined,
    eventTimeStart: f.eventTimeStart || undefined,
    eventTimeEnd: f.eventTimeEnd || undefined,
    expectedDurationHours: f.expectedDurationHours ? Number(f.expectedDurationHours) : undefined,
    paymentTermTemplateId: f.paymentTermTemplateId || undefined,
    vatRate: f.vatRate,
    shippingAmountMinor: toMinor(f.shippingAmount),
    introText: f.introText || undefined,
    outroText: f.outroText || undefined,
    internalNotes: f.internalNotes || undefined,
    ccPdfEmail: f.ccPdfEmail || undefined,
    businessBankAccountId: f.businessBankAccountId || undefined,
    lineItems: f.lineItems.map((li) => ({
      position: li.position,
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: toMinor(li.unitPrice),
      discountPercent: li.discountPercent,
    })),
  };
}

export const QuoteEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = id && id !== 'new';

  const [form, setForm] = useState<FormState>(empty);
  const [busy, setBusy] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');

  // Load existing quote
  const { data: existing, isLoading } = useQuery({
    queryKey: ['quote', id],
    queryFn: () => quotesService.get(parseInt(id!, 10)),
    enabled: !!isEdit,
  });

  useEffect(() => {
    if (existing) {
      const q = existing.quote;
      setForm({
        customerAccountId: q.customerAccountId,
        customerLabel: q.customer.companyName || q.customer.displayName || q.customer.email || '',
        language: q.language,
        currency: q.currency,
        issueDate: q.issueDate,
        validUntil: q.validUntil || '',
        eventName: q.eventName || '',
        eventDate: q.eventDate || '',
        eventTimeStart: q.eventTimeStart || '',
        eventTimeEnd: q.eventTimeEnd || '',
        expectedDurationHours: q.expectedDurationHours?.toString() || '',
        paymentTermTemplateId: q.paymentTermTemplateId,
        vatRate: Number(q.vatRate || 0),
        shippingAmount: Number(q.shippingAmountMinor || 0) / 100,
        introText: q.introText || '',
        outroText: q.outroText || '',
        internalNotes: q.internalNotes || '',
        ccPdfEmail: q.ccPdfEmail || '',
        businessBankAccountId: q.businessBankAccountId,
        lineItems: existing.lineItems.map((li) => ({
          id: li.id,
          position: li.position,
          quantity: Number(li.quantity),
          description: li.description,
          unitPrice: Number(li.unitPriceMinor || 0) / 100,
          discountPercent: Number(li.discountPercent || 0),
        })),
      });
    }
  }, [existing]);

  // Customer autocomplete
  const { data: customerOptions } = useQuery({
    queryKey: ['customer-search', customerSearch],
    queryFn: () => customerAdminService.search(customerSearch),
    enabled: customerSearch.length >= 2,
    staleTime: 5000,
  });

  // Payment-term templates + line-item presets
  const { data: ptTemplates } = useQuery({
    queryKey: ['payment-term-templates'],
    queryFn: () => quotesService.listPaymentTermTemplates(),
  });
  const { data: liPresets } = useQuery({
    queryKey: ['line-item-presets'],
    queryFn: () => quotesService.listLineItemPresets(),
  });

  // Admin user list — used to pre-fill + offer a dropdown for the
  // "CC PDF to" field, mirroring CreateEventPage's admin_email picker.
  // Falls back to an empty list silently if the current user lacks
  // users.view permission so basic admins still get the auto-prefill
  // from the currently signed-in admin.
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

  // Auto-prefill the CC PDF email with the current admin's email, only
  // on a brand-new quote and only once. Don't clobber edits or existing
  // values from a saved quote.
  const didPrefillCcRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillCcRef.current) return;
    if (!currentAdmin?.email) return;
    didPrefillCcRef.current = true;
    setForm((prev) => (prev.ccPdfEmail ? prev : { ...prev, ccPdfEmail: currentAdmin.email }));
  }, [currentAdmin?.email, isEdit]);

  const installmentPreview = useMemo<PaymentTermInstallment[]>(() => {
    const tpl = ptTemplates?.templates.find((x) => x.id === form.paymentTermTemplateId);
    return tpl?.installments || [];
  }, [ptTemplates, form.paymentTermTemplateId]);

  const handleSave = async (then?: 'send' | 'preview') => {
    if (!form.customerAccountId) {
      toast.error(t('quotes.errors.customerRequired', 'Pick a customer first.'));
      return;
    }
    setBusy(true);
    try {
      const payload = buildPayload(form);
      const saved = isEdit
        ? await quotesService.update(parseInt(id!, 10), payload)
        : await quotesService.create(payload);
      queryClient.invalidateQueries({ queryKey: ['quotes'] });

      if (then === 'send') {
        if (!window.confirm(t('quotes.confirmSend', 'Send this quote to the customer now?'))) {
          setBusy(false);
          return;
        }
        await quotesService.send(saved.quote.id);
        toast.success(t('quotes.sentToast', 'Quote sent to customer.'));
        navigate(`/admin/clients/quotes/${saved.quote.id}`);
      } else if (then === 'preview') {
        const url = await quotesService.pdfUrl(saved.quote.id);
        window.open(url, '_blank');
        navigate(`/admin/clients/quotes/${saved.quote.id}`);
      } else {
        toast.success(t('quotes.savedToast', 'Quote saved as draft.'));
        navigate(`/admin/clients/quotes/${saved.quote.id}`);
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const handlePreviewUnsaved = async () => {
    if (!form.customerAccountId) {
      toast.error(t('quotes.errors.customerRequired', 'Pick a customer first.'));
      return;
    }
    try {
      const url = await quotesService.previewPdfUrl(buildPayload(form));
      window.open(url, '_blank');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err.message || 'Preview failed');
    }
  };

  if (isEdit && isLoading) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/admin/clients/quotes')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold">
            {isEdit ? `${t('quotes.edit', 'Edit quote')} ${existing?.quote.quoteNumber || ''}` : t('quotes.new', 'New quote')}
          </h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handlePreviewUnsaved} disabled={busy}>
            <Eye className="w-4 h-4 mr-1" />{t('quotes.preview', 'Preview PDF')}
          </Button>
          <Button variant="outline" onClick={() => handleSave()} disabled={busy}>
            {t('common.save', 'Save')}
          </Button>
          <Button onClick={() => handleSave('send')} disabled={busy}>
            <Send className="w-4 h-4 mr-1" />{t('quotes.saveAndSend', 'Save & send')}
          </Button>
        </div>
      </div>

      {/* Section: Customer */}
      <Card>
        <h3 className="font-semibold mb-2">1. {t('quotes.section.customer', 'Customer')}</h3>
        {form.customerAccountId ? (
          <div className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-800 rounded-md px-3 py-2">
            <span className="text-sm">{form.customerLabel}</span>
            <Button variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, customerAccountId: null, customerLabel: '' }))}>
              {t('common.change', 'Change')}
            </Button>
          </div>
        ) : (
          <>
            <Input
              placeholder={t('quotes.customerSearch', 'Search customer by email or company…') as string}
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
            />
            {customerOptions && customerOptions.length > 0 && (
              <ul className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-700 divide-y divide-neutral-200 dark:divide-neutral-700">
                {customerOptions.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-sm"
                      onClick={() => setForm((f) => ({
                        ...f,
                        customerAccountId: c.id,
                        customerLabel: c.companyName || c.displayName || c.email,
                      }))}
                    >
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

      {/* Section: Event */}
      <Card>
        <h3 className="font-semibold mb-2">2. {t('quotes.section.event', 'Event details')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('quotes.field.eventName', 'Event name') as string} value={form.eventName}
            onChange={(e) => setForm((f) => ({ ...f, eventName: e.target.value }))} />
          <Input type="date" label={t('quotes.field.eventDate', 'Event date') as string} value={form.eventDate}
            onChange={(e) => setForm((f) => ({ ...f, eventDate: e.target.value }))} />
          <Input type="time" label={t('quotes.field.eventTimeStart', 'Start time') as string} value={form.eventTimeStart}
            onChange={(e) => setForm((f) => ({ ...f, eventTimeStart: e.target.value }))} />
          <Input type="time" label={t('quotes.field.eventTimeEnd', 'End time') as string} value={form.eventTimeEnd}
            onChange={(e) => setForm((f) => ({ ...f, eventTimeEnd: e.target.value }))} />
          <Input type="number" step="0.5" label={t('quotes.field.expectedDuration', 'Expected duration (h)') as string}
            value={form.expectedDurationHours}
            onChange={(e) => setForm((f) => ({ ...f, expectedDurationHours: e.target.value }))} />
          <Input type="date" label={t('quotes.field.validUntil', 'Valid until') as string} value={form.validUntil}
            onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))} />
        </div>
      </Card>

      {/* Section: Line items */}
      <Card>
        <h3 className="font-semibold mb-2">3. {t('quotes.section.lineItems', 'Line items')}</h3>
        <LineItemsTable
          items={form.lineItems}
          currency={form.currency}
          showDiscount={true}
          vatRate={form.vatRate / 100}
          shippingAmount={form.shippingAmount}
          presets={liPresets?.presets || []}
          onChange={(items) => setForm((f) => ({ ...f, lineItems: items }))}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <Input type="number" step="0.1" label={t('quotes.field.vatRate', 'VAT rate %') as string}
            value={form.vatRate}
            onChange={(e) => setForm((f) => ({ ...f, vatRate: Number(e.target.value) }))} />
          <Input type="number" step="0.01" label={t('quotes.field.shipping', 'Shipping amount') as string}
            value={form.shippingAmount}
            onChange={(e) => setForm((f) => ({ ...f, shippingAmount: Number(e.target.value) }))} />
          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.currency', 'Currency')}</label>
            <select value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option>CHF</option><option>EUR</option><option>USD</option><option>GBP</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Section: Payment */}
      <Card>
        <h3 className="font-semibold mb-2">4. {t('quotes.section.payment', 'Payment conditions')}</h3>
        <select
          className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
          value={form.paymentTermTemplateId || ''}
          onChange={(e) => setForm((f) => ({ ...f, paymentTermTemplateId: e.target.value ? Number(e.target.value) : null }))}
        >
          <option value="">{t('quotes.field.selectPaymentTerm', '— Select payment terms —')}</option>
          {ptTemplates?.templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
          ))}
        </select>
        {installmentPreview.length > 0 && (
          <ul className="mt-3 text-sm space-y-1 text-neutral-600 dark:text-neutral-400">
            {installmentPreview.map((inst, i) => (
              <li key={i}>• {inst.percent}% — {inst.label} ({t(`quotes.trigger.${inst.trigger}`, inst.trigger)}{inst.offset_days ? `, ${inst.offset_days}d` : ''})</li>
            ))}
          </ul>
        )}
      </Card>

      {/* Section: Extras */}
      <Card>
        <h3 className="font-semibold mb-2">5. {t('quotes.section.extras', 'Intro / outro / extras')}</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.introText', 'Intro text')}</label>
            <textarea rows={3} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              value={form.introText} onChange={(e) => setForm((f) => ({ ...f, introText: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.outroText', 'Outro text')}</label>
            <textarea rows={3} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              value={form.outroText} onChange={(e) => setForm((f) => ({ ...f, outroText: e.target.value }))} />
          </div>

          {/* CC PDF — admin email prefilled, with a picker when more
              than one admin exists. Mirrors the admin_email field on
              CreateEventPage so the muscle memory carries over. */}
          <div className="space-y-1">
            <Input
              type="email"
              label={t('quotes.field.ccPdfEmail', 'CC PDF to (extra recipient)') as string}
              placeholder={t('quotes.field.ccPdfEmailPlaceholder', 'name@example.com') as string}
              value={form.ccPdfEmail}
              onChange={(e) => setForm((f) => ({ ...f, ccPdfEmail: e.target.value }))}
            />
            {activeAdmins.length > 1 && (
              <div className="flex items-center gap-2">
                <label htmlFor="cc-pdf-picker" className="text-xs text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                  {t('quotes.field.ccPdfPickFromAdmins', 'Pick from admins:')}
                </label>
                <select
                  id="cc-pdf-picker"
                  value={activeAdmins.some((a: any) => a.email === form.ccPdfEmail) ? form.ccPdfEmail : ''}
                  onChange={(e) => {
                    const email = e.target.value;
                    if (email) setForm((prev) => ({ ...prev, ccPdfEmail: email }));
                  }}
                  className="text-xs px-2 py-1 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                >
                  <option value="">{t('quotes.field.ccPdfCustom', 'Custom email')}</option>
                  {activeAdmins.map((a: any) => (
                    <option key={a.id} value={a.email}>{a.email}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.internalNotes', 'Internal notes (not on PDF)')}</label>
            <textarea rows={3} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              value={form.internalNotes} onChange={(e) => setForm((f) => ({ ...f, internalNotes: e.target.value }))} />
          </div>
        </div>
      </Card>
    </div>
  );
};

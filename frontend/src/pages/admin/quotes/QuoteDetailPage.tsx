/**
 * Quote detail (read + actions). Renders a summary of the quote plus
 * action buttons: Preview PDF / Resend / Duplicate / Convert to event.
 * Edit hops back to the editor.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Send, Copy, ArrowRightCircle, Edit2, Receipt } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { quotesService } from '../../../services/quotes.service';
import { formatMoney } from '../../../components/admin/LineItemsTable';
import { toast } from 'react-toastify';

export const QuoteDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['quote', id],
    queryFn: () => quotesService.get(parseInt(id!, 10)),
    enabled: !!id,
  });

  if (isLoading || !data) return <Loading />;
  const q = data.quote;

  const handlePreview = async () => {
    // Open the placeholder window synchronously so the browser sees a
    // user-gesture-initiated popup; redirect to the blob URL once the
    // PDF buffer is fetched. Without this the popup blocker kills it.
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('quotes.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    try {
      const url = await quotesService.pdfUrl(q.id);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || err.message || 'Preview failed');
    }
  };

  const handleSend = async () => {
    if (!window.confirm(t('quotes.confirmSend', 'Send this quote to the customer now?'))) return;
    try {
      await quotesService.send(q.id);
      toast.success(t('quotes.sentToast', 'Quote sent to customer.'));
      qc.invalidateQueries({ queryKey: ['quote', id] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Send failed');
    }
  };

  const handleConvert = async () => {
    if (!window.confirm(t('quotes.confirmConvert', 'Convert this accepted quote into an event + scheduled invoices?'))) return;
    try {
      const result = await quotesService.convert(q.id);
      toast.success(t('quotes.convertedToast', 'Quote converted to event #{{id}}', { id: result.eventId }));
      qc.invalidateQueries({ queryKey: ['quote', id] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Convert failed');
    }
  };

  const handleConvertToInvoice = async () => {
    if (!window.confirm(t('quotes.confirmConvertToInvoice',
      'Convert this quote into invoice(s) only? No gallery / event will be created.'))) return;
    try {
      const result = await quotesService.convertToInvoice(q.id);
      toast.success(t('quotes.convertedToInvoiceToast',
        '{{count}} invoice(s) created from this quote', { count: result.installmentsCreated }));
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Convert failed');
    }
  };

  const handleDuplicate = async () => {
    try {
      const result = await quotesService.duplicate(q.id);
      navigate(`/admin/clients/quotes/${result.id}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Duplicate failed');
    }
  };

  const responseLocked = q.responseLockedAt && new Date(q.responseLockedAt).getTime() < Date.now();
  const canSend = ['draft', 'declined', 'expired'].includes(q.status);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/admin/clients/quotes')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold">
            {q.quoteNumber} <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded bg-neutral-100 text-neutral-700">{t(`quotes.status.${q.status}`, q.status)}</span>
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {q.customer.companyName || q.customer.displayName || q.customer.email}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={handlePreview}><Eye className="w-4 h-4 mr-1" />{t('common.preview', 'Preview')}</Button>
          <Button variant="outline" onClick={() => navigate(`/admin/clients/quotes/${q.id}/edit`)}>
            <Edit2 className="w-4 h-4 mr-1" />{t('common.edit', 'Edit')}
          </Button>
          <Button variant="outline" onClick={handleDuplicate}><Copy className="w-4 h-4 mr-1" />{t('common.duplicate', 'Duplicate')}</Button>
          {canSend && <Button onClick={handleSend}><Send className="w-4 h-4 mr-1" />{q.status === 'draft' ? t('quotes.send', 'Send') : t('quotes.resend', 'Resend')}</Button>}
          {q.status === 'accepted' && (
            <>
              <Button onClick={handleConvert}>
                <ArrowRightCircle className="w-4 h-4 mr-1" />{t('quotes.convert', 'Convert to event')}
              </Button>
              {/* Direct convert-to-invoice for engagements without a
                  photo deliverable (consulting, hire, etc). Hidden
                  once converted to either an event or to invoices. */}
              <Button variant="outline" onClick={handleConvertToInvoice}>
                <Receipt className="w-4 h-4 mr-1" />{t('quotes.convertToInvoice', 'Convert to invoice only')}
              </Button>
            </>
          )}
        </div>
      </div>

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><div className="text-neutral-500">{t('quotes.field.issueDate', 'Issued')}</div><div>{q.issueDate}</div></div>
          {q.validUntil && <div><div className="text-neutral-500">{t('quotes.field.validUntil', 'Valid until')}</div><div>{q.validUntil}</div></div>}
          <div><div className="text-neutral-500">{t('quotes.field.eventName', 'Event')}</div><div>{q.eventName || '—'}</div></div>
          {q.eventDate && <div><div className="text-neutral-500">{t('quotes.field.eventDate', 'Event date')}</div><div>{q.eventDate}{q.eventTimeStart ? ` ${q.eventTimeStart}-${q.eventTimeEnd || ''}` : ''}</div></div>}
          {q.sentAt && <div><div className="text-neutral-500">{t('quotes.field.sentAt', 'Sent at')}</div><div>{new Date(q.sentAt).toLocaleString()}</div></div>}
          {q.acceptedAt && <div><div className="text-neutral-500">{t('quotes.field.acceptedAt', 'Accepted at')}</div><div>{new Date(q.acceptedAt).toLocaleString()}</div></div>}
          {q.declinedAt && <div><div className="text-neutral-500">{t('quotes.field.declinedAt', 'Declined at')}</div><div>{new Date(q.declinedAt).toLocaleString()}</div></div>}
          {q.respondedAt && !responseLocked && (
            <div><div className="text-neutral-500">{t('quotes.field.responseWindow', 'Response window')}</div>
              <div className="text-amber-700">{t('quotes.responseWindowOpen', 'Open until {{at}}', { at: q.responseLockedAt && new Date(q.responseLockedAt).toLocaleTimeString() })}</div></div>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('quotes.section.lineItems', 'Line items')}</h3>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-neutral-200 dark:border-neutral-700">
            <th className="text-left py-2">#</th>
            <th className="text-left py-2">{t('crm.lineItems.quantity', 'Qty')}</th>
            <th className="text-left py-2">{t('crm.lineItems.description', 'Description')}</th>
            <th className="text-right py-2">{t('crm.lineItems.unitPrice', 'Unit')}</th>
            <th className="text-right py-2">{t('crm.lineItems.total', 'Total')}</th>
          </tr></thead>
          <tbody>
            {data.lineItems.map((li) => (
              <tr key={li.id} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-2">{li.position}</td>
                <td className="py-2">{Number(li.quantity)}</td>
                <td className="py-2 whitespace-pre-line">{li.description}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(Number(li.unitPriceMinor || 0) / 100, q.currency)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(Number(li.lineTotalMinor || 0) / 100, q.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-col items-end gap-1 mt-4 text-sm">
          <div className="flex gap-6"><span className="text-neutral-600">{t('crm.lineItems.subtotal', 'Subtotal')}:</span>
            <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.netAmountMinor || 0) / 100, q.currency)}</span></div>
          <div className="flex gap-6"><span className="text-neutral-600">{t('crm.lineItems.vat', 'VAT')} ({Number(q.vatRate || 0).toFixed(1)}%):</span>
            <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.vatAmountMinor || 0) / 100, q.currency)}</span></div>
          <div className="flex gap-6 font-semibold text-base"><span>{t('crm.lineItems.total', 'Total')}:</span>
            <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.totalAmountMinor || 0) / 100, q.currency)}</span></div>
        </div>
      </Card>

      {q.internalNotes && (
        <Card>
          <h3 className="font-semibold mb-2">{t('quotes.section.internalNotes', 'Internal notes')}</h3>
          <p className="text-sm whitespace-pre-line text-neutral-700 dark:text-neutral-300">{q.internalNotes}</p>
        </Card>
      )}
    </div>
  );
};

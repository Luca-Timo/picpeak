/**
 * Invoice detail page. Displays the invoice + line items + payment log;
 * exposes the action set: Preview PDF, Send, Mark paid (modal), Send
 * reminder (manual escalation), Cancel.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Send, CheckCircle, BellRing, XCircle } from 'lucide-react';
import { Button, Card, Loading, Input } from '../../../components/common';
import { billsService } from '../../../services/bills.service';
import { formatMoney } from '../../../components/admin/LineItemsTable';
import { toast } from 'react-toastify';

export const BillDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => billsService.get(parseInt(id!, 10)),
    enabled: !!id,
  });

  const [payDialogOpen, setPayDialogOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('');
  const [payReference, setPayReference] = useState('');
  const [payNotes, setPayNotes] = useState('');

  if (isLoading || !data) return <Loading />;
  const inv = data.invoice;

  const handlePreview = async () => {
    const url = await billsService.pdfUrl(inv.id);
    window.open(url, '_blank');
  };
  const handleSend = async () => {
    if (!window.confirm(t('bills.confirmSend', 'Send invoice to customer now?'))) return;
    try { await billsService.send(inv.id); toast.success(t('bills.sentToast', 'Invoice sent.')); qc.invalidateQueries({ queryKey: ['invoice', id] }); }
    catch (e: any) { toast.error(e?.response?.data?.error || 'Send failed'); }
  };
  const handleReminder = async () => {
    if (!window.confirm(t('bills.confirmReminder', 'Send a reminder now?'))) return;
    try { await billsService.sendReminder(inv.id); toast.success(t('bills.reminderToast', 'Reminder sent.')); qc.invalidateQueries({ queryKey: ['invoice', id] }); }
    catch (e: any) { toast.error(e?.response?.data?.error || 'Reminder failed'); }
  };
  const handleCancel = async () => {
    if (!window.confirm(t('bills.confirmCancel', 'Cancel this invoice?'))) return;
    try { await billsService.cancel(inv.id); toast.success(t('bills.cancelledToast', 'Invoice cancelled.')); qc.invalidateQueries({ queryKey: ['invoice', id] }); }
    catch (e: any) { toast.error(e?.response?.data?.error || 'Cancel failed'); }
  };
  const submitPayment = async () => {
    try {
      await billsService.markPaid(inv.id, {
        amountMinor: Math.round(Number(payAmount) * 100),
        paymentMethod: payMethod || undefined,
        reference: payReference || undefined,
        notes: payNotes || undefined,
      });
      setPayDialogOpen(false);
      setPayAmount(''); setPayMethod(''); setPayReference(''); setPayNotes('');
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      toast.success(t('bills.paymentRecordedToast', 'Payment recorded.'));
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to record payment');
    }
  };

  const outstanding = (Number(inv.totalAmountMinor || 0) + Number(inv.lateFeeAmountMinor || 0) - Number(inv.paidAmountMinor || 0)) / 100;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/admin/clients/bills')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold">{inv.invoiceNumber}
            <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded bg-neutral-100 text-neutral-700">
              {t(`bills.status.${inv.status}`, inv.status)}
            </span>
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {inv.customer.companyName || inv.customer.displayName || inv.customer.email}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={handlePreview}><Eye className="w-4 h-4 mr-1" />{t('common.preview', 'Preview')}</Button>
          {['scheduled', 'sent', 'overdue'].includes(inv.status) && (
            <Button onClick={handleSend}><Send className="w-4 h-4 mr-1" />{inv.status === 'scheduled' ? t('bills.sendNow', 'Send now') : t('bills.resend', 'Resend')}</Button>
          )}
          {inv.status !== 'paid' && inv.status !== 'cancelled' && (
            <Button variant="outline" onClick={() => setPayDialogOpen(true)}>
              <CheckCircle className="w-4 h-4 mr-1" />{t('bills.markPaid', 'Mark paid')}
            </Button>
          )}
          {(inv.status === 'sent' || inv.status === 'overdue') && inv.reminderLevel < 2 && (
            <Button variant="outline" onClick={handleReminder}>
              <BellRing className="w-4 h-4 mr-1" />{t('bills.sendReminder', 'Send reminder')}
            </Button>
          )}
          {inv.status !== 'paid' && inv.status !== 'cancelled' && (
            <Button variant="outline" onClick={handleCancel}>
              <XCircle className="w-4 h-4 mr-1" />{t('common.cancel', 'Cancel')}
            </Button>
          )}
        </div>
      </div>

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><div className="text-neutral-500">{t('bills.field.issueDate', 'Issued')}</div><div>{inv.issueDate}</div></div>
          <div><div className="text-neutral-500">{t('bills.field.dueDate', 'Due')}</div><div>{inv.dueDate}</div></div>
          {inv.scheduledSendAt && <div><div className="text-neutral-500">{t('bills.field.scheduledSendAt', 'Scheduled send')}</div><div>{new Date(inv.scheduledSendAt).toLocaleDateString()}</div></div>}
          {inv.installmentTotal > 1 && <div><div className="text-neutral-500">{t('bills.field.installment', 'Installment')}</div><div>{inv.installmentIndex + 1}/{inv.installmentTotal}</div></div>}
          <div><div className="text-neutral-500">{t('bills.field.total', 'Total')}</div><div>{formatMoney(Number(inv.totalAmountMinor || 0) / 100, inv.currency)}</div></div>
          <div><div className="text-neutral-500">{t('bills.field.paid', 'Paid')}</div><div>{formatMoney(Number(inv.paidAmountMinor || 0) / 100, inv.currency)}</div></div>
          <div><div className="text-neutral-500">{t('bills.field.outstanding', 'Outstanding')}</div>
            <div className={outstanding > 0 ? 'text-red-700 font-medium' : ''}>{formatMoney(outstanding, inv.currency)}</div></div>
          {inv.lateFeeAmountMinor > 0 && <div><div className="text-neutral-500">{t('bills.field.lateFee', 'Late fee')}</div><div className="text-amber-700">{formatMoney(Number(inv.lateFeeAmountMinor) / 100, inv.currency)}</div></div>}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('bills.section.lineItems', 'Line items')}</h3>
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
                <td className="py-2 text-right tabular-nums">{formatMoney(Number(li.unitPriceMinor || 0) / 100, inv.currency)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(Number(li.lineTotalMinor || 0) / 100, inv.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('bills.section.paymentLog', 'Payment log')}</h3>
        {data.payments.length === 0 ? (
          <p className="text-sm text-neutral-500">{t('bills.noPayments', 'No payments recorded yet.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-neutral-200 dark:border-neutral-700">
              <th className="text-left py-2">{t('bills.payment.paidAt', 'Date')}</th>
              <th className="text-right py-2">{t('bills.payment.amount', 'Amount')}</th>
              <th className="text-left py-2">{t('bills.payment.method', 'Method')}</th>
              <th className="text-left py-2">{t('bills.payment.reference', 'Reference')}</th>
              <th className="text-left py-2">{t('bills.payment.notes', 'Notes')}</th>
            </tr></thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id} className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-2">{new Date(p.paidAt).toLocaleDateString()}</td>
                  <td className="py-2 text-right tabular-nums">{formatMoney(Number(p.amountMinor) / 100, inv.currency)}</td>
                  <td className="py-2">{p.paymentMethod || '—'}</td>
                  <td className="py-2 font-mono text-xs">{p.reference || '—'}</td>
                  <td className="py-2">{p.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {payDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPayDialogOpen(false)}>
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl w-full max-w-md mx-4 p-5"
            onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold mb-3 text-lg">{t('bills.markPaid', 'Mark paid')}</h3>
            <div className="space-y-3">
              <Input type="number" step="0.01" label={t('bills.payment.amount', 'Amount') as string} value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)} placeholder={String(outstanding.toFixed(2))} />
              <Input label={t('bills.payment.method', 'Payment method') as string} value={payMethod} onChange={(e) => setPayMethod(e.target.value)} />
              <Input label={t('bills.payment.reference', 'Reference (optional)') as string} value={payReference} onChange={(e) => setPayReference(e.target.value)} />
              <div>
                <label className="block text-sm font-medium mb-1">{t('bills.payment.notes', 'Notes')}</label>
                <textarea rows={3} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
                  value={payNotes} onChange={(e) => setPayNotes(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setPayDialogOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
                <Button onClick={submitPayment} disabled={!payAmount}>{t('bills.recordPayment', 'Record payment')}</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

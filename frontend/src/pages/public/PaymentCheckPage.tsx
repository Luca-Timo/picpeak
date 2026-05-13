/**
 * Public payment-check landing page. Mounted at /payment-check/:token
 * (outside any auth gate). The admin arrives here from the email
 * button — the token in the URL is the only credential.
 *
 * Three actions:
 *   - Paid in full  → confirm, POST 'paid_full'
 *   - Partial       → enter amount, POST 'partial' with amountMinor
 *   - Not paid yet  → confirm, POST 'unpaid'
 *
 * On success the page renders a status block explaining what just
 * happened (invoice marked paid / reminder queued / etc.) so the
 * admin has a clear receipt of the action.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Wallet, AlertTriangle } from 'lucide-react';
import { paymentCheckService, type PaymentCheckAction, type PaymentCheckView } from '../../services/paymentCheck.service';
import { Loading } from '../../components/common';

function formatMoney(minor: number, currency: string, locale = 'de-CH') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: (currency || 'CHF').toUpperCase(),
  }).format(Number(minor || 0) / 100);
}

function formatShortDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export const PaymentCheckPage: React.FC = () => {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const initialAction = (searchParams.get('action') as PaymentCheckAction) || null;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['payment-check', token],
    queryFn: () => paymentCheckService.get(token!),
    enabled: !!token,
    retry: false,
  });

  const [action, setAction] = useState<PaymentCheckAction | null>(null);
  const [partialAmount, setPartialAmount] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ applied: PaymentCheckAction; reminderLevel?: number; reminderSkipped?: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Pre-select the action from the URL query param so the button
  // the admin clicked is the one immediately visible.
  useEffect(() => {
    if (!action && initialAction && ['paid_full', 'partial', 'unpaid'].includes(initialAction)) {
      setAction(initialAction);
    }
  }, [initialAction, action]);

  // Pre-fill the partial amount with the outstanding total — most
  // admins click "Partial" because they got SOME of the money, so
  // showing the full outstanding as the starting value lets them
  // just type the actual received value over the top.
  useEffect(() => {
    if (action === 'partial' && data && !partialAmount) {
      setPartialAmount((data.outstandingMinor / 100).toFixed(2));
    }
  }, [action, data, partialAmount]);

  if (!token) {
    return <ErrorBox message={t('paymentCheck.missingToken', 'Missing token')} />;
  }
  if (isLoading) return <Loading />;
  if (isError) {
    const status = (error as any)?.response?.status;
    const code = (error as any)?.response?.data?.code;
    if (status === 410 && code === 'TOKEN_ALREADY_USED') {
      const usedAction = (error as any)?.response?.data?.usedAction;
      return <ErrorBox message={t('paymentCheck.alreadyUsed',
        'This link has already been used (action: {{action}}). If you need to record another payment, open the invoice in admin.',
        { action: usedAction || '' })} />;
    }
    if (status === 410) {
      return <ErrorBox message={t('paymentCheck.expired',
        'This link has expired. Open the invoice in admin to record the payment manually.')} />;
    }
    return <ErrorBox message={t('paymentCheck.loadError', 'Could not load invoice. The link may be invalid.')} />;
  }
  const inv: PaymentCheckView = data!;

  if (result) return <ResultBox result={result} inv={inv} />;

  const submit = async () => {
    if (!action) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      let amountMinor: number | undefined;
      if (action === 'partial') {
        const v = Number(partialAmount);
        if (!Number.isFinite(v) || v <= 0) {
          setSubmitError(t('paymentCheck.partialInvalid', 'Enter a positive amount.'));
          setSubmitting(false);
          return;
        }
        amountMinor = Math.round(v * 100);
        if (amountMinor > inv.outstandingMinor) {
          setSubmitError(t('paymentCheck.partialTooHigh',
            'Amount cannot exceed the outstanding total ({{max}}).',
            { max: formatMoney(inv.outstandingMinor, inv.currency) }));
          setSubmitting(false);
          return;
        }
      }
      const res = await paymentCheckService.record(token, { action, amountMinor });
      setResult(res);
    } catch (e: any) {
      setSubmitError(e?.response?.data?.error || t('paymentCheck.submitError', 'Could not record action.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 py-10 px-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">{t('paymentCheck.title', 'Confirm payment')}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-6">
          {t('paymentCheck.subtitle',
            'Select what was received for this invoice. The choice is logged and the appropriate reminder is queued automatically.')}
        </p>

        <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-5 mb-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs uppercase text-neutral-500">{t('paymentCheck.field.invoice', 'Invoice')}</div>
              <div className="font-mono">{inv.invoiceNumber}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-neutral-500">{t('paymentCheck.field.customer', 'Customer')}</div>
              <div>{inv.customer.label}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-neutral-500">{t('paymentCheck.field.issued', 'Issued')}</div>
              <div>{formatShortDate(inv.issueDate)}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-neutral-500">{t('paymentCheck.field.due', 'Due')}</div>
              <div>{formatShortDate(inv.dueDate)}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-neutral-500">{t('paymentCheck.field.total', 'Total')}</div>
              <div className="tabular-nums">{formatMoney(inv.totalMinor, inv.currency)}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-neutral-500">{t('paymentCheck.field.outstanding', 'Outstanding')}</div>
              <div className="tabular-nums font-semibold">{formatMoney(inv.outstandingMinor, inv.currency)}</div>
            </div>
            {inv.paidMinor > 0 && (
              <div>
                <div className="text-xs uppercase text-neutral-500">{t('paymentCheck.field.paid', 'Already paid')}</div>
                <div className="tabular-nums">{formatMoney(inv.paidMinor, inv.currency)}</div>
              </div>
            )}
            {inv.lateFeeMinor > 0 && (
              <div>
                <div className="text-xs uppercase text-neutral-500">{t('paymentCheck.field.lateFee', 'Late fee')}</div>
                <div className="tabular-nums text-amber-700 dark:text-amber-400">{formatMoney(inv.lateFeeMinor, inv.currency)}</div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <ActionCard
            label={t('paymentCheck.action.paidFull', 'Paid in full')}
            description={t('paymentCheck.action.paidFullHelp',
              'Mark the entire outstanding amount ({{amount}}) as received. No reminder is sent.',
              { amount: formatMoney(inv.outstandingMinor, inv.currency) })}
            icon={<CheckCircle2 className="w-5 h-5 text-green-600" />}
            selected={action === 'paid_full'}
            onSelect={() => setAction('paid_full')}
          />
          <ActionCard
            label={t('paymentCheck.action.partial', 'Partially paid')}
            description={t('paymentCheck.action.partialHelp',
              'Log the amount received, then queue the customer reminder for the remainder.')}
            icon={<Wallet className="w-5 h-5 text-blue-600" />}
            selected={action === 'partial'}
            onSelect={() => setAction('partial')}
          >
            {action === 'partial' && (
              <div className="mt-3">
                <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
                  {t('paymentCheck.action.partialAmount', 'Amount received')}
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{inv.currency}</span>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    max={inv.outstandingMinor / 100}
                    value={partialAmount}
                    onChange={(e) => setPartialAmount(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-sm"
                  />
                </div>
                <p className="text-xs text-neutral-500 mt-1">
                  {t('paymentCheck.action.partialMax', 'Max: {{max}}', {
                    max: formatMoney(inv.outstandingMinor, inv.currency),
                  })}
                </p>
              </div>
            )}
          </ActionCard>
          <ActionCard
            label={t('paymentCheck.action.unpaid', 'Not paid yet')}
            description={t('paymentCheck.action.unpaidHelp',
              'Nothing received. The customer reminder will be queued{{fee}}.',
              { fee: inv.reminderLevel >= 1 ? t('paymentCheck.action.unpaidWithFee', ' (with late fee at second reminder)') : '' })}
            icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
            selected={action === 'unpaid'}
            onSelect={() => setAction('unpaid')}
          />
        </div>

        {submitError && (
          <p className="mt-4 text-sm text-red-600">{submitError}</p>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!action || submitting}
            className="px-6 py-3 rounded-md bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white font-medium"
          >
            {submitting ? t('paymentCheck.submitting', 'Recording…') : t('paymentCheck.submit', 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ActionCardProps {
  label: string;
  description: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}
const ActionCard: React.FC<ActionCardProps> = ({ label, description, icon, selected, onSelect, children }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`w-full text-left rounded-lg border p-4 transition-colors ${
      selected
        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
        : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700'
    }`}
  >
    <div className="flex items-start gap-3">
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{description}</div>
        {children}
      </div>
    </div>
  </button>
);

const ErrorBox: React.FC<{ message: string }> = ({ message }) => (
  <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 flex items-center justify-center p-6">
    <div className="max-w-md w-full rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-6">
      <h1 className="text-lg font-bold text-red-800 dark:text-red-300 mb-2">
        {message}
      </h1>
    </div>
  </div>
);

const ResultBox: React.FC<{ result: { applied: PaymentCheckAction; reminderLevel?: number; reminderSkipped?: string }; inv: PaymentCheckView }> = ({ result, inv }) => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-lg border border-green-200 dark:border-green-900/40 bg-green-50 dark:bg-green-900/20 p-6">
        <CheckCircle2 className="w-10 h-10 text-green-600 mb-3" />
        <h1 className="text-lg font-bold text-green-800 dark:text-green-300 mb-1">
          {t('paymentCheck.result.title', 'Action recorded')}
        </h1>
        <p className="text-sm text-neutral-700 dark:text-neutral-200">
          {result.applied === 'paid_full' && t('paymentCheck.result.paid',
            'Invoice {{n}} marked as paid in full.', { n: inv.invoiceNumber })}
          {result.applied === 'partial' && t('paymentCheck.result.partial',
            'Partial payment logged for invoice {{n}}. Customer reminder queued for the remainder.',
            { n: inv.invoiceNumber })}
          {result.applied === 'unpaid' && result.reminderSkipped === 'max_level_reached'
            && t('paymentCheck.result.unpaidMax',
              'Recorded as unpaid. Maximum reminder level already reached — handle this customer offline.')}
          {result.applied === 'unpaid' && !result.reminderSkipped
            && t('paymentCheck.result.unpaid',
              'Recorded as unpaid. Customer reminder queued (level {{lvl}}).',
              { lvl: result.reminderLevel || 1 })}
        </p>
        <p className="text-xs text-neutral-500 mt-4">
          {t('paymentCheck.result.close', 'You can close this tab.')}
        </p>
      </div>
    </div>
  );
};

export default PaymentCheckPage;

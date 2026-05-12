/**
 * Customer-side Quotes list. Read-only view of every quote the
 * photographer has sent this customer. Open links straight back to
 * the public quote response page when the quote is still in the
 * accept/decline window — saves the customer from digging through
 * email to find the original link.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FileText, ExternalLink } from 'lucide-react';
import { customerService, type CustomerQuote } from '../../services/customer.service';
import { Card, Loading } from '../../components/common';

function formatMoney(amount: number, currency: string, locale = 'de-CH') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: (currency || 'CHF').toUpperCase() }).format(amount);
}
function formatShortDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export const CustomerQuotesPage: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['customer-quotes'],
    queryFn: () => customerService.listQuotes(),
  });

  if (isLoading) return <Loading />;
  if (isError) {
    const status = (error as any)?.response?.status;
    if (status === 403) {
      return (
        <div className="container py-8">
          <h1 className="text-2xl font-bold mb-2">{t('customer.quotes.title', 'Quotes')}</h1>
          <p className="text-muted-theme">
            {t('customer.quotes.disabled',
              'This feature is currently disabled for your account. Please contact your photographer if you expected to see quotes here.')}
          </p>
        </div>
      );
    }
    return (
      <div className="container py-8">
        <p className="text-red-600">{t('customer.quotes.loadError', 'Could not load quotes.')}</p>
      </div>
    );
  }
  const quotes = data || [];

  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme flex items-center gap-2">
          <FileText className="w-6 h-6" />
          {t('customer.quotes.title', 'Quotes')}
        </h1>
        <p className="text-sm text-muted-theme mt-1">
          {t('customer.quotes.subtitle',
            'Every quote your photographer has sent you. Click an open quote to accept or decline.')}
        </p>
      </div>

      {quotes.length === 0 ? (
        <Card padding="lg">
          <p className="text-center text-muted-theme py-8">
            {t('customer.quotes.empty', 'No quotes yet.')}
          </p>
        </Card>
      ) : (
        <Card padding="none">
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {quotes.map((q: CustomerQuote) => (
              <QuoteRow key={q.id} q={q} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
};

const QuoteRow: React.FC<{ q: CustomerQuote }> = ({ q }) => {
  const { t } = useTranslation();
  // Open the public response page when the quote is still actionable.
  // Once locked (responded_at + 15 min) or converted/expired the page
  // becomes a read-only view of the locked state.
  const canRespond = q.status === 'sent' || (
    !!q.respondedAt && !!q.responseLockedAt && new Date(q.responseLockedAt).getTime() > Date.now()
  );
  const linkHref = q.responseToken ? `/quote/${q.responseToken}` : null;

  const statusClass =
    q.status === 'accepted' || q.status === 'converted' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
    : q.status === 'declined' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    : q.status === 'sent' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
    : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300';

  const body = (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm">{q.quoteNumber}</span>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusClass}`}>
            {t(`quotes.status.${q.status}`, q.status)}
          </span>
        </div>
        <div className="text-sm text-muted-theme mt-1 truncate">
          {q.eventName || t('customer.quotes.noEventName', '—')}
          {q.eventDate ? ` · ${formatShortDate(q.eventDate)}` : ''}
          {q.validUntil && canRespond ? ` · ${t('quoteResponse.validUntil', 'valid until')} ${formatShortDate(q.validUntil)}` : ''}
        </div>
      </div>
      <div className="text-right">
        <div className="font-medium tabular-nums">
          {formatMoney(Number(q.totalAmountMinor) / 100, q.currency)}
        </div>
        {canRespond && linkHref && (
          <div className="text-xs text-primary-600 dark:text-primary-400 mt-1 inline-flex items-center gap-1">
            {t('customer.quotes.openToRespond', 'Open to respond')}
            <ExternalLink className="w-3 h-3" />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <li>
      {linkHref ? (
        <a href={linkHref} target={canRespond ? '_blank' : '_self'} rel="noopener noreferrer"
          className="block hover:bg-neutral-50 dark:hover:bg-neutral-800">
          {body}
        </a>
      ) : body}
    </li>
  );
};

export default CustomerQuotesPage;

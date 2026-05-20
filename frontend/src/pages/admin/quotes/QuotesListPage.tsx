/**
 * Quotes list page. Filters by status / customer / search; sortable by
 * date / customer / value; paginated.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { quotesService, type QuoteStatus, type QuoteSort } from '../../../services/quotes.service';
import { Button, Card, Loading } from '../../../components/common';
import { formatMoney } from '../../../components/admin/LineItemsTable';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

const STATUSES: QuoteStatus[] = ['draft', 'sent', 'accepted', 'declined', 'expired', 'converted'];

export const QuotesListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { format: fmtDate } = useLocalizedDate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<QuoteStatus[]>([]);
  const [sort, setSort] = useState<QuoteSort>('newest');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['quotes', { search, statusFilter, sort, page }],
    queryFn: () => quotesService.list({
      q: search || undefined,
      status: statusFilter.length ? statusFilter : undefined,
      sort, page, pageSize: 25,
    }),
  });

  const toggleStatus = (s: QuoteStatus) => {
    setStatusFilter((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
    setPage(1);
  };

  return (
    <div className="container py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-theme">{t('quotes.title', 'Quotes')}</h1>
            {/* Beta badge — feature is functional but the surface is
                still evolving (matches Customers + Invoices). */}
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title="Beta — feature is functional but still evolving"
            >
              {t('navigation.betaTag', 'Beta')}
            </span>
          </div>
          <p className="text-sm text-muted-theme mt-1">
            {t('quotes.subtitle', 'Send, track and convert quotes into events.')}
          </p>
        </div>
        <Link to="/admin/clients/quotes/new">
          <Button><Plus className="w-4 h-4 mr-1" />{t('quotes.new', 'New quote')}</Button>
        </Link>
      </div>

      <Card padding="lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder={t('quotes.searchPlaceholder', 'Search by number, customer, event…') as string}
              className="w-full pl-9 pr-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select
            className="px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as QuoteSort)}
          >
            <option value="newest">{t('quotes.sort.newest', 'Newest first')}</option>
            <option value="oldest">{t('quotes.sort.oldest', 'Oldest first')}</option>
            <option value="customer_asc">{t('quotes.sort.customerAsc', 'Customer A→Z')}</option>
            <option value="value_asc">{t('quotes.sort.valueAsc', 'Value low→high')}</option>
            <option value="value_desc">{t('quotes.sort.valueDesc', 'Value high→low')}</option>
          </select>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {STATUSES.map((s) => {
            const active = statusFilter.includes(s);
            return (
              <button key={s} type="button" onClick={() => toggleStatus(s)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? 'bg-accent-dark text-white border-accent-dark'
                    : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600'
                }`}
              >{t(`quotes.status.${s}`, s)}</button>
            );
          })}
        </div>

        {/* Body of the same card — table or empty state. Matches the
            single-card layout used by Customers/Invitations. */}
        <div className="mt-4">
          {isLoading ? <Loading /> : !data || data.quotes.length === 0 ? (
            <p className="text-center text-muted-theme py-8">{t('quotes.empty', 'No quotes yet.')}</p>
          ) : (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">{t('quotes.table.customer', 'Customer')}</th>
                      <th className="px-3 py-2 text-left">{t('quotes.table.event', 'Event')}</th>
                      <th className="px-3 py-2 text-left">{t('quotes.table.issueDate', 'Issued')}</th>
                      <th className="px-3 py-2 text-right">{t('quotes.table.total', 'Total')}</th>
                      <th className="px-3 py-2 text-left">{t('quotes.table.status', 'Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.quotes.map((q) => (
                      <tr key={q.id}
                        className="border-t border-neutral-200 dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        onClick={() => navigate(`/admin/clients/quotes/${q.id}`)}
                      >
                        <td className="px-3 py-2 font-mono text-xs">{q.quoteNumber}</td>
                        <td className="px-3 py-2">{q.customer.companyName || q.customer.displayName || q.customer.email}</td>
                        <td className="px-3 py-2 truncate max-w-xs">{q.eventName || '—'}</td>
                        <td className="px-3 py-2">{fmtDate(q.issueDate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMoney(Number(q.totalAmountMinor) / 100, q.currency)}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            q.status === 'accepted' || q.status === 'converted' ? 'bg-green-100 text-green-800'
                              : q.status === 'declined' ? 'bg-red-100 text-red-800'
                              : q.status === 'sent' ? 'bg-blue-100 text-blue-800'
                              : 'bg-neutral-100 text-neutral-700'
                          }`}>{t(`quotes.status.${q.status}`, q.status)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.pagination.totalPages > 1 && (
                <div className="flex justify-between items-center px-3 py-2 border-t border-neutral-200 dark:border-neutral-700 text-sm">
                  <span className="text-muted-theme">
                    {t('quotes.pagination', 'Page {{page}} of {{total}} · {{count}} quotes', {
                      page: data.pagination.page, total: data.pagination.totalPages, count: data.pagination.total,
                    })}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                      {t('common.previous', 'Previous')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={page >= data.pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
                      {t('common.next', 'Next')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

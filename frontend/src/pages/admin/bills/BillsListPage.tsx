/**
 * Bills (invoices) list. Mirrors QuotesListPage shape; adds an
 * "unpaid only" toggle and sorts including by due-date.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { billsService, type InvoiceStatus, type InvoiceSort } from '../../../services/bills.service';
import { Button, Card, Loading } from '../../../components/common';
import { formatMoney } from '../../../components/admin/LineItemsTable';

const STATUSES: InvoiceStatus[] = ['scheduled', 'sent', 'paid', 'overdue', 'cancelled'];

export const BillsListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus[]>([]);
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [sort, setSort] = useState<InvoiceSort>('newest');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', { search, statusFilter, unpaidOnly, sort, page }],
    queryFn: () => billsService.list({
      q: search || undefined,
      status: statusFilter.length ? statusFilter : undefined,
      unpaidOnly,
      sort, page, pageSize: 25,
    }),
  });

  const toggleStatus = (s: InvoiceStatus) => {
    setStatusFilter((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
    setPage(1);
  };

  return (
    <div className="container py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-theme">{t('bills.title', 'Invoices')}</h1>
            {/* Beta badge — matches the Customers + Quotes pages. */}
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title="Beta — feature is functional but still evolving"
            >
              {t('navigation.betaTag', 'Beta')}
            </span>
          </div>
          <p className="text-sm text-muted-theme mt-1">
            {t('bills.subtitle', 'Schedule, send, track payments and chase late invoices.')}
          </p>
        </div>
        <Link to="/admin/clients/bills/new">
          <Button><Plus className="w-4 h-4 mr-1" />{t('bills.new', 'New invoice')}</Button>
        </Link>
      </div>

      <Card padding="lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder={t('bills.searchPlaceholder', 'Search by number or customer…') as string}
              className="w-full pl-9 pr-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select
            className="px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as InvoiceSort)}
          >
            <option value="newest">{t('bills.sort.newest', 'Newest first')}</option>
            <option value="due_asc">{t('bills.sort.dueAsc', 'Due soon first')}</option>
            <option value="due_desc">{t('bills.sort.dueDesc', 'Due latest first')}</option>
            <option value="customer_asc">{t('bills.sort.customerAsc', 'Customer A→Z')}</option>
            <option value="value_asc">{t('bills.sort.valueAsc', 'Value low→high')}</option>
            <option value="value_desc">{t('bills.sort.valueDesc', 'Value high→low')}</option>
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unpaidOnly} onChange={(e) => setUnpaidOnly(e.target.checked)} />
            {t('bills.filter.unpaidOnly', 'Unpaid only')}
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {STATUSES.map((s) => {
            const active = statusFilter.includes(s);
            return (
              <button key={s} type="button" onClick={() => toggleStatus(s)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active ? 'bg-accent-dark text-white border-accent-dark' : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600'
                }`}
              >{t(`bills.status.${s}`, s)}</button>
            );
          })}
        </div>

        {/* Body inside the same card (matches Customers + Quotes). */}
        <div className="mt-4">
          {isLoading ? <Loading /> : !data || data.invoices.length === 0 ? (
            <p className="text-center text-muted-theme py-8">{t('bills.empty', 'No invoices yet.')}</p>
          ) : (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">{t('bills.table.customer', 'Customer')}</th>
                      <th className="px-3 py-2 text-left">{t('bills.table.installment', 'Installment')}</th>
                      <th className="px-3 py-2 text-left">{t('bills.table.dueDate', 'Due')}</th>
                      <th className="px-3 py-2 text-right">{t('bills.table.total', 'Total')}</th>
                      <th className="px-3 py-2 text-left">{t('bills.table.status', 'Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.invoices.map((inv) => (
                      <tr key={inv.id}
                        className="border-t border-neutral-200 dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        onClick={() => navigate(`/admin/clients/bills/${inv.id}`)}
                      >
                        <td className="px-3 py-2 font-mono text-xs">{inv.invoiceNumber}</td>
                        <td className="px-3 py-2">{inv.customer.companyName || inv.customer.displayName || inv.customer.email}</td>
                        <td className="px-3 py-2 text-xs text-muted-theme">
                          {inv.installmentTotal > 1 ? `${inv.installmentIndex + 1}/${inv.installmentTotal} · ${inv.installmentLabel || ''}` : '—'}
                        </td>
                        <td className="px-3 py-2">{inv.dueDate}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMoney(Number(inv.totalAmountMinor) / 100, inv.currency)}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            inv.status === 'paid' ? 'bg-green-100 text-green-800'
                              : inv.status === 'overdue' ? 'bg-red-100 text-red-800'
                              : inv.status === 'sent' ? 'bg-blue-100 text-blue-800'
                              : inv.status === 'cancelled' ? 'bg-neutral-200 text-neutral-600'
                              : 'bg-amber-100 text-amber-800'
                          }`}>{t(`bills.status.${inv.status}`, inv.status)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

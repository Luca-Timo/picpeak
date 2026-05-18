/**
 * Admin → Contracts list page.
 *
 * Lists every contract (filterable by status + customer + search) with
 * a "New contract" button and a "Block library" shortcut. Mirrors the
 * BillsListPage / QuotesListPage layout so it slots into the existing
 * /admin/clients sub-nav without visual surprise.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, BookOpen, ScrollText } from 'lucide-react';
import { Card, Loading } from '../../../components/common';
import {
  contractsService,
  type ContractStatus,
  type ContractSort,
} from '../../../services/contracts.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

const STATUSES: ContractStatus[] = [
  'draft', 'sent', 'signed_by_customer', 'signed_by_admin', 'fully_signed', 'cancelled',
];

function StatusBadge({ status }: { status: ContractStatus }) {
  const { t } = useTranslation();
  const cls =
    status === 'fully_signed'      ? 'bg-green-100 text-green-800'
    : status === 'signed_by_customer' ? 'bg-blue-100 text-blue-800'
    : status === 'signed_by_admin' ? 'bg-blue-100 text-blue-800'
    : status === 'sent'            ? 'bg-amber-100 text-amber-800'
    : status === 'cancelled'       ? 'bg-neutral-200 text-neutral-600'
    : 'bg-neutral-100 text-neutral-700';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {t(`contracts.status.${status}`, status)}
    </span>
  );
}

export const ContractsListPage: React.FC = () => {
  const { t } = useTranslation();
  const { formatDate } = useLocalizedDate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ContractStatus[]>([]);
  const [sort, setSort] = useState<ContractSort>('newest');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['contracts', { search, statusFilter, sort, page }],
    queryFn: () => contractsService.list({
      q: search || undefined,
      status: statusFilter.length ? statusFilter : undefined,
      sort, page, pageSize: 25,
    }),
  });

  function toggleStatus(s: ContractStatus) {
    setPage(1);
    setStatusFilter((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <ScrollText className="w-6 h-6" />
            {t('contracts.title', 'Contracts')}
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">
            {t('contracts.subtitle', 'Compose contracts from reusable blocks and have customers sign in-browser or upload a wet-signed PDF.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/admin/clients/contracts/blocks"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700"
          >
            <BookOpen className="w-4 h-4" />
            {t('contracts.list.blocksLibrary', 'Block library')}
          </Link>
          <Link
            to="/admin/clients/contracts/new"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90"
          >
            <Plus className="w-4 h-4" />
            {t('contracts.list.new', 'New contract')}
          </Link>
        </div>
      </div>

      <Card padding="lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder={t('contracts.list.searchPlaceholder', 'Search by number, title or customer…') as string}
              className="w-full pl-9 pr-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select
            className="px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as ContractSort)}
          >
            <option value="newest">{t('contracts.list.sort.newest', 'Newest first')}</option>
            <option value="oldest">{t('contracts.list.sort.oldest', 'Oldest first')}</option>
            <option value="customer_asc">{t('contracts.list.sort.customer', 'Customer A→Z')}</option>
          </select>
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {STATUSES.map((s) => {
            const active = statusFilter.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? 'bg-accent-dark text-white border-accent-dark'
                    : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600'
                }`}
              >
                {t(`contracts.status.${s}`, s)}
              </button>
            );
          })}
        </div>

        <div className="mt-4">
          {isLoading ? (
            <Loading />
          ) : !data || data.contracts.length === 0 ? (
            <p className="text-center text-neutral-500 py-8">
              {t('contracts.list.empty', 'No contracts yet.')}
            </p>
          ) : (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-900 text-left">
                  <tr>
                    <th className="px-3 py-2">{t('contracts.list.table.number', 'Number')}</th>
                    <th className="px-3 py-2">{t('contracts.list.table.customer', 'Customer')}</th>
                    <th className="px-3 py-2">{t('contracts.list.table.title', 'Title')}</th>
                    <th className="px-3 py-2">{t('contracts.list.table.issueDate', 'Issued')}</th>
                    <th className="px-3 py-2">{t('contracts.list.table.status', 'Status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contracts.map((c) => (
                    <tr
                      key={c.id}
                      className="border-t border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
                    >
                      <td className="px-3 py-2">
                        <Link
                          to={`/admin/clients/contracts/${c.id}`}
                          className="font-mono text-accent-dark hover:underline"
                        >
                          {c.contractNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        {c.customer.companyName
                          || [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ')
                          || c.customer.displayName
                          || c.customer.email
                          || '—'}
                      </td>
                      <td className="px-3 py-2 max-w-xs truncate">{c.title || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(c.issueDate)}</td>
                      <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {data && data.total > data.pageSize && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <span>
              {t('contracts.list.pageOf', 'Page {{page}} of {{total}}', { page, total: totalPages })}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1 rounded border border-neutral-300 dark:border-neutral-600 disabled:opacity-50"
              >
                ‹
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1 rounded border border-neutral-300 dark:border-neutral-600 disabled:opacity-50"
              >
                ›
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

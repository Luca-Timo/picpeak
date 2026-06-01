/**
 * CRM → Tax / Steuer Report sub-page.
 *
 * Period-scoped revenue listing for tax filing. Filters live in the
 * URL? No — they live in component state for now (kept simple). Three
 * actions on the page:
 *
 *   1. Filter: period preset + currency  → react-query refetch
 *   2. Export PDF (landscape A4, company letterhead)
 *   3. Export CSV (RFC 4180, accountant-friendly)
 *
 * The table shows cancelled invoices in grey + a "Storniert" badge so
 * the invoice-number sequence stays gap-free (DE/CH/AT audit trail
 * requirement). Their amounts are visible but excluded from the
 * totals card on the right.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Calculator, Download, FileDown, AlertCircle } from 'lucide-react';
import { Button, Card, Loading, LocalizedDateInput } from '../../../components/common';

// Lightweight native select styled to match Input — the common barrel
// doesn't export a Select component, and the form pieces here are
// small enough that a plain styled <select> is the right call.
const selectClassName =
  'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500';
import { taxReportService, type TaxReportParams } from '../../../services/taxReport.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { toast } from 'react-toastify';

type PeriodPreset = 'thisYear' | 'lastYear' | 'thisQuarter' | 'lastQuarter' | 'custom';

function isoDate(d: Date): string {
  // YYYY-MM-DD in local time. Tax reports are user-facing — a Swiss
  // admin asking for "this quarter" means their local Q, not UTC.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function periodForPreset(preset: PeriodPreset, today = new Date()): { from: string; to: string } {
  const y = today.getFullYear();
  if (preset === 'thisYear') return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (preset === 'lastYear') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  const quarter = Math.floor(today.getMonth() / 3); // 0..3
  if (preset === 'thisQuarter') {
    const startMonth = quarter * 3;
    const endMonth = startMonth + 2;
    const lastDay = new Date(y, endMonth + 1, 0).getDate();
    return {
      from: `${y}-${String(startMonth + 1).padStart(2, '0')}-01`,
      to:   `${y}-${String(endMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  // lastQuarter — handle Q1 rollover into previous year's Q4.
  let lastQYear = y;
  let lastQ = quarter - 1;
  if (lastQ < 0) { lastQ = 3; lastQYear = y - 1; }
  const startMonth = lastQ * 3;
  const endMonth = startMonth + 2;
  const lastDay = new Date(lastQYear, endMonth + 1, 0).getDate();
  return {
    from: `${lastQYear}-${String(startMonth + 1).padStart(2, '0')}-01`,
    to:   `${lastQYear}-${String(endMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

function formatMinor(minor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format((minor || 0) / 100);
}

function triggerBrowserDownload(url: string, filename: string) {
  // Off-DOM anchor + click is the cross-browser idiom for blob
  // downloads. The blob URL is revoked after a short delay so Safari
  // has time to start the actual download (revoking too early breaks it).
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const TaxReportPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const [preset, setPreset] = useState<PeriodPreset>('thisYear');
  const initialPeriod = useMemo(() => periodForPreset('thisYear'), []);
  const [from, setFrom] = useState(initialPeriod.from);
  const [to,   setTo]   = useState(initialPeriod.to);
  const [currency, setCurrency] = useState<string>('CHF');
  const [isExporting, setIsExporting] = useState<'pdf' | 'csv' | null>(null);

  const onPresetChange = (next: PeriodPreset) => {
    setPreset(next);
    if (next !== 'custom') {
      const p = periodForPreset(next);
      setFrom(p.from);
      setTo(p.to);
    }
  };

  const params: TaxReportParams = { from, to, currency, locale: i18n.language };

  const { data: report, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tax-report', params],
    queryFn: () => taxReportService.getReport(params),
    enabled: Boolean(from && to && currency),
    // Tax data is slow-moving — no need to re-fetch on focus.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const handleExport = async (format: 'pdf' | 'csv') => {
    setIsExporting(format);
    try {
      const { url, filename } = format === 'pdf'
        ? await taxReportService.downloadPdfUrl(params)
        : await taxReportService.downloadCsvUrl(params);
      triggerBrowserDownload(url, filename);
    } catch (err) {
      toast.error(t('taxReport.exportFailed', 'Export failed. Please try again.'));
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      setIsExporting(null);
    }
  };

  // Per maintainer: every CH/LI/DE/AT-based business writes 1'000.00
  // regardless of document language, so we default to de-CH (the only
  // Intl locale producing apostrophe thousands). Non-DACH operators
  // can override later if needed.
  const intlLocale = 'de-CH';

  // Show the per-VAT-rate breakdown only when there are 2+ distinct
  // rates in the period. With a single rate the breakdown is just a
  // restatement of the grand totals — pure noise.
  const showPerRateBreakdown = (report?.totalsByVatRate.length || 0) > 1;
  const exportsDisabled = isLoading || isExporting !== null || !report || report.rows.length === 0;

  return (
    <div className="space-y-6">
      {/* Top row — filter card on the left (stacked rows, narrower
          footprint), compact totals card on the right. Both cards sit
          above the table so the table gets the full content width. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 items-start">
        {/* Filter card (left) */}
        <Card padding="md">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-accent-soft text-on-accent-soft flex items-center justify-center flex-shrink-0">
              <Calculator className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {t('taxReport.title', 'Tax report')}
              </h1>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-0.5">
                {t(
                  'taxReport.intro',
                  'Period-scoped revenue list with net + VAT breakdown grouped by VAT rate. Cancelled invoices stay visible for audit-trail continuity but are excluded from totals.',
                )}
              </p>
            </div>
          </div>

          {/* Filters stacked vertically per the agreed layout:
              Row 1: period preset (full width)
              Row 2: from / to (side-by-side)
              Row 3: currency (full width)
              Row 4: export buttons (right-aligned) */}
          <div className="space-y-3">
            <div>
              <label htmlFor="period-preset" className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('taxReport.filters.period', 'Period')}
              </label>
              <select
                id="period-preset"
                value={preset}
                onChange={(e) => onPresetChange(e.target.value as PeriodPreset)}
                className={selectClassName}
              >
                <option value="thisYear">{t('taxReport.filters.thisYear', 'This year')}</option>
                <option value="lastYear">{t('taxReport.filters.lastYear', 'Last year')}</option>
                <option value="thisQuarter">{t('taxReport.filters.thisQuarter', 'This quarter')}</option>
                <option value="lastQuarter">{t('taxReport.filters.lastQuarter', 'Last quarter')}</option>
                <option value="custom">{t('taxReport.filters.custom', 'Custom range')}</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('taxReport.filters.from', 'From')}
                </label>
                <LocalizedDateInput
                  value={from}
                  onChange={(iso) => { setFrom(iso); setPreset('custom'); }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('taxReport.filters.to', 'To')}
                </label>
                <LocalizedDateInput
                  value={to}
                  onChange={(iso) => { setTo(iso); setPreset('custom'); }}
                />
              </div>
            </div>

            <div>
              <label htmlFor="currency" className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('taxReport.filters.currency', 'Currency')}
              </label>
              <select
                id="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className={selectClassName}
              >
                <option value="CHF">CHF</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => handleExport('csv')}
                disabled={exportsDisabled}
                isLoading={isExporting === 'csv'}
                leftIcon={<FileDown className="w-4 h-4" />}
              >
                {t('taxReport.exportCsv', 'Export CSV')}
              </Button>
              <Button
                variant="primary"
                onClick={() => handleExport('pdf')}
                disabled={exportsDisabled}
                isLoading={isExporting === 'pdf'}
                leftIcon={<Download className="w-4 h-4" />}
              >
                {t('taxReport.exportPdf', 'Export PDF')}
              </Button>
            </div>
          </div>
        </Card>

        {/* Totals card (right) — compact summary. Headline is the
            grand totals; the per-VAT-rate breakdown appears only when
            there are 2+ rates in the period (otherwise it duplicates
            the grand totals). Cancelled footnote at the bottom when
            applicable. */}
        {report && report.rows.length > 0 && (
          <Card padding="md">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.grandTotalNet', 'Total net')}</span>
                <span className="tabular-nums font-medium text-neutral-900 dark:text-neutral-100">
                  {formatMinor(report.grandTotalNet, report.currency, intlLocale)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.grandTotalVat', 'Total VAT')}</span>
                <span className="tabular-nums font-medium text-neutral-900 dark:text-neutral-100">
                  {formatMinor(report.grandTotalVat, report.currency, intlLocale)}
                </span>
              </div>
              <div className="flex justify-between gap-3 pt-1.5 border-t border-neutral-200 dark:border-neutral-700">
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">{t('taxReport.grandTotalGross', 'Total gross')}</span>
                <span className="tabular-nums font-semibold text-neutral-900 dark:text-neutral-100">
                  {formatMinor(report.grandTotal, report.currency, intlLocale)}
                </span>
              </div>
            </div>

            {showPerRateBreakdown && (
              <div className="mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
                  {t('taxReport.totalsByVatRate', 'Totals by VAT rate')}
                </h2>
                <div className="space-y-2 text-sm">
                  {report.totalsByVatRate.map((b) => (
                    <div key={b.vatRate}>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        {Number(b.vatRate).toFixed(1)}%
                      </div>
                      <div className="flex justify-between gap-3 tabular-nums">
                        <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.col.net', 'Net')}</span>
                        <span>{formatMinor(b.netMinor, report.currency, intlLocale)}</span>
                      </div>
                      <div className="flex justify-between gap-3 tabular-nums">
                        <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.col.vat', 'VAT')}</span>
                        <span>{formatMinor(b.vatMinor, report.currency, intlLocale)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {report.cancelledCount > 0 && (
              <p className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700 text-xs text-neutral-500 dark:text-neutral-400">
                {t('taxReport.cancelledFootnote', '{{count}} cancelled invoice(s) — amounts excluded from totals (shown for audit-trail continuity).', { count: report.cancelledCount })}
              </p>
            )}
          </Card>
        )}
      </div>

      {/* Results */}
      {isLoading ? (
        <Card padding="lg"><Loading /></Card>
      ) : isError ? (
        <Card padding="lg">
          <div className="flex items-start gap-3 text-amber-700 dark:text-amber-400">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{t('taxReport.errorTitle', 'Could not load tax report')}</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
                {(error as Error)?.message || String(error)}
              </p>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-3">
                {t('common.retry', 'Retry')}
              </Button>
            </div>
          </div>
        </Card>
      ) : !report || report.rows.length === 0 ? (
        <Card padding="lg">
          <p className="text-center text-sm text-neutral-600 dark:text-neutral-400">
            {t('taxReport.empty', 'No invoices in this period.')}
          </p>
        </Card>
      ) : (
        <>
          {/* Table — full width below the filter + totals row above.
              The totals card now lives in the top-right of the page
              header so this section is purely the invoice list. */}
          <Card padding="none">
            {/* Two nested wrappers: the OUTER clips the header row's
                solid fill so the top corners stay rounded (matches
                the Card's own rounded-xl). The INNER provides
                horizontal scroll when the table is wider than the
                viewport. Combining `overflow-hidden` + `overflow-x-auto`
                on a single element would cancel the auto-scroll. */}
            <div className="rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300">
                  <tr>
                    <th className="px-2 py-2 text-right font-medium w-10">#</th>
                    <th className="px-2 py-2 text-left font-medium whitespace-nowrap">{t('taxReport.col.date', 'Date')}</th>
                    <th className="px-2 py-2 text-left font-medium whitespace-nowrap">{t('taxReport.col.invoice', 'Invoice')}</th>
                    <th className="px-2 py-2 text-left font-medium">{t('taxReport.col.customer', 'Customer')}</th>
                    <th className="px-2 py-2 text-left font-medium">{t('taxReport.col.event', 'Event')}</th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">{t('taxReport.col.vatRate', 'VAT %')}</th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">{t('taxReport.col.net', 'Net')}</th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">{t('taxReport.col.vat', 'VAT')}</th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">{t('taxReport.col.total', 'Gross')}</th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">{t('taxReport.col.skonto', 'Skonto')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {report.rows.map((row, i) => (
                    <tr
                      key={row.id}
                      className={row.isCancelled
                        ? 'text-neutral-400 dark:text-neutral-500 italic'
                        : 'text-neutral-900 dark:text-neutral-100'}
                    >
                      <td className="px-2 py-1.5 text-right tabular-nums">{i + 1}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{fmtDate(row.issueDate.slice(0, 10))}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <span className="font-medium">{row.invoiceNumber}</span>
                        {row.isCancelled && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 font-semibold not-italic">
                            {t('taxReport.statusCancelled', 'Cancelled')}
                          </span>
                        )}
                        {/* Storno + Reissue lineage markers — parity
                            with the admin invoices list so the same
                            colour scheme distinguishes the three row
                            kinds at a glance across both surfaces. */}
                        {row.kind === 'storno' && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded bg-purple-100 text-purple-800 font-semibold not-italic">
                            {t('bills.kind.storno', 'Storno')}
                          </span>
                        )}
                        {row.isReissue && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded bg-blue-100 text-blue-800 font-semibold not-italic">
                            {t('bills.kind.reissue', 'Reissue')}
                          </span>
                        )}
                        {row.replacedByInvoiceNumber && (
                          <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400 not-italic">
                            → {row.replacedByInvoiceNumber}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 truncate max-w-[180px]" title={row.customerLabel}>{row.customerLabel}</td>
                      <td className="px-2 py-1.5 truncate max-w-[180px]" title={row.eventName}>{row.eventName}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{Number(row.vatRate).toFixed(1)}%</td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatMinor(row.netMinor, row.currency, intlLocale)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatMinor(row.vatMinor, row.currency, intlLocale)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap font-medium">
                        {formatMinor(row.totalMinor, row.currency, intlLocale)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap"
                        title={row.skontoApplied
                          ? t('taxReport.skontoTooltip', 'Paid with Skonto') as string
                          : undefined}>
                        {row.skontoApplied ? (
                          <span className="text-teal-700 dark:text-teal-300">
                            −{formatMinor(row.skontoAmountMinor, row.currency, intlLocale)}
                          </span>
                        ) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
};

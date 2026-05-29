/**
 * Hours section card (migration 129).
 *
 * Used in two places:
 *   1. CustomerDetailPage — rendered when the per-customer
 *      `feature_hours_logging` flag is on AND the master `hoursLogging`
 *      flag is on. Sits between the features card and account actions.
 *   2. The standalone /admin/clients/hours page — admin picks ANY
 *      customer with hours logging enabled, then sees this card.
 *
 * Wraps customerAdminService.{list,create,delete,billUnbilled}HourEntries.
 * All writes go through react-query invalidation so the entry list
 * refreshes after every action.
 */
import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Clock } from 'lucide-react';
import { Button, Card } from '../common';
import { DecimalInput } from '../common/DecimalInput';
import { parseLocaleDecimal, parseDuration } from '../../utils/parsers';
import { customerAdminService } from '../../services/customerAdmin.service';
import { businessProfileService } from '../../services/businessProfile.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

export interface HoursSectionProps {
  customerId: number;
  customerHourlyRateMinor: number | null;
  billingCadence: 'per_event' | 'monthly' | 'quarterly';
  onHourlyRateChange?: (next: number | null) => void;
  /**
   * When true, render only the entry-history table + the per-event
   * "Bill these hours" action. Hides the inline log-entry form and
   * the default-rate input. Used on the customer detail page now
   * that logging itself lives on the standalone /admin/clients/hours
   * surface — the detail page becomes a read-only history view with
   * the on-demand bill action for per-event customers.
   */
  compact?: boolean;
}

export const HoursSection: React.FC<HoursSectionProps> = ({
  customerId, customerHourlyRateMinor, billingCadence, onHourlyRateChange, compact,
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { format: fmtDate, formatTime: fmtTime, timeFormat } = useLocalizedDate();
  // `lang` hint on <input type="time"> nudges Chrome/Edge to render the
  // picker in the matching clock convention (de-DE → 24h, en-US → 12h).
  // Safari/Firefox follow OS locale and ignore this — that's a browser
  // limitation, not something we can fix in the page. The underlying
  // value stays HH:mm (24h) regardless of how the picker presents it.
  const timeInputLang = timeFormat === '12h' ? 'en-US' : 'de-DE';
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [duration, setDuration] = useState<string>('');
  const [rateOverride, setRateOverride] = useState<string>('');
  const [description, setDescription] = useState('');

  // Duration shortcut — admin types "1.5", "1,5", "1:30" or "1h" and
  // the end-time jumps to start + duration. Pure convenience; the End
  // input still works for explicit times. Empty / unparseable input is
  // a no-op so a typo doesn't overwrite a freshly-edited End.
  const applyDuration = (raw: string) => {
    const minutes = parseDuration(raw);
    if (minutes == null) return;
    const [hh, mm] = startTime.split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;
    const totalEnd = Math.min(hh * 60 + mm + minutes, 24 * 60 - 1);
    const eh = Math.floor(totalEnd / 60).toString().padStart(2, '0');
    const em = (totalEnd % 60).toString().padStart(2, '0');
    setEndTime(`${eh}:${em}`);
  };

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['admin-customer-hour-entries', customerId],
    queryFn: () => customerAdminService.listHourEntries(customerId),
    enabled: Number.isFinite(customerId) && customerId > 0,
  });

  // Pull the configured default currency so the hint can show
  // "{{currency}} 150" instead of the hardcoded "CHF 150". Same cache
  // key as CustomerDetailPage so a single round-trip serves both
  // mount points. 5-minute stale window — the value changes via
  // Settings → Business profile, not during a hours-logging session.
  const { data: profileSnapshot } = useQuery({
    queryKey: ['business-profile-snapshot'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60 * 1000,
  });
  const profileDefaultCurrency = profileSnapshot?.profile?.defaultCurrency || 'CHF';

  const createMutation = useMutation({
    mutationFn: () => customerAdminService.createHourEntry(customerId, {
      entryDate, startTime, endTime,
      // Locale-tolerant: "12,50" and "12.50" both yield 1250.
      hourlyRateMinorOverride: (() => {
        if (!rateOverride) return null;
        const n = parseLocaleDecimal(rateOverride);
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
      })(),
      description: description || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
      qc.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      setStartTime('09:00');
      setEndTime('10:00');
      setDuration('');
      setRateOverride('');
      setDescription('');
      toast.success(t('customers.hours.toast.created', 'Entry logged'));
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error || err?.message || 'Failed to log entry';
      toast.error(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entryId: number) => customerAdminService.deleteHourEntry(customerId, entryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
      qc.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      toast.success(t('customers.hours.toast.deleted', 'Entry deleted'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || 'Failed to delete entry');
    },
  });

  const billMutation = useMutation({
    mutationFn: () => customerAdminService.billUnbilledHourEntries(customerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
      qc.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      toast.success(t('customers.hours.toast.billed', 'Hours billed'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || 'Failed to bill hours');
    },
  });

  // Single pass — both the count and the money total live behind the
  // same filter. Memoised so a parent re-render (e.g. the
  // CustomerDetailPage form state changing) doesn't reshuffle the
  // entries array in JS on every keystroke.
  const { unbilledCount, unbilledTotalMajor } = useMemo(() => {
    let count = 0;
    let minor = 0;
    for (const e of entries) {
      if (e.status !== 'unbilled') continue;
      count += 1;
      const rateMinor = e.hourlyRateMinorOverride ?? customerHourlyRateMinor ?? 0;
      minor += rateMinor * e.durationMinutes / 60;
    }
    return { unbilledCount: count, unbilledTotalMajor: minor / 100 };
  }, [entries, customerHourlyRateMinor]);
  const isMonthly = billingCadence === 'monthly';

  // Local lockout check — mirrors customerHoursService.isEntryLocked
  // so the delete button can be disabled before the request is sent.
  const isLocked = (entry: typeof entries[number]) => {
    if (!entry.invoiceId) return false;
    if (entry.invoiceIsMonthlyDraft) return false;
    if (entry.invoiceStatus !== 'scheduled') return true;
    if (!entry.invoiceScheduledSendAt) return false;
    return new Date(entry.invoiceScheduledSendAt).getTime() <= Date.now();
  };

  return (
    <Card padding="lg">
      <h2 className="text-lg font-semibold text-theme mb-1 flex items-center gap-2">
        <Clock className="w-5 h-5" />
        {t('customers.hours.section', 'Hours')}
      </h2>
      <p className="text-xs text-muted-theme mb-4">
        {isMonthly
          ? t('customers.hours.monthlyHint',
            'Entries auto-append to the current monthly draft. Edit / delete remains possible until the scheduler arms the draft for send.')
          : t('customers.hours.perEventHint',
            'Logged entries stay unbilled until you click "Create draft invoice" — a standalone draft invoice is generated with one line per entry, ready for you to review before sending.')}
      </p>

      {/* Default rate — hidden in compact mode (history-only on the
          customer detail page; admin edits the rate elsewhere). */}
      {!compact && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-theme mb-1">
            {t('customers.field.hourlyRate', 'Default hourly rate')}
          </label>
          <DecimalInput
            value={customerHourlyRateMinor != null ? customerHourlyRateMinor / 100 : NaN}
            fractionDigits={2}
            onChange={(n) => {
              if (!onHourlyRateChange) return;
              if (!Number.isFinite(n)) {
                onHourlyRateChange(null);
                return;
              }
              onHourlyRateChange(Math.max(0, Math.round(n * 100)));
            }}
            disabled={!onHourlyRateChange}
            className="w-40 input"
            placeholder="150.00"
          />
          <p className="text-xs text-muted-theme mt-1">
            {t('customers.field.hourlyRateHint',
              'Major units (e.g. 150.00 for {{currency}} 150). Leave blank to require a per-entry override on every block.',
              { currency: profileDefaultCurrency })}
          </p>
        </div>
      )}

      {/* Inline log-new-entry form — hidden in compact mode. Logging
          lives on the standalone /admin/clients/hours surface. */}
      {!compact && (
      <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4 mb-4">
        <h3 className="text-sm font-semibold mb-3">{t('customers.hours.form.title', 'Log new entry')}</h3>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.date', 'Date')}
            </label>
            <input type="date" value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.start', 'Start')}
            </label>
            <input type="time" lang={timeInputLang} value={startTime}
              onChange={(e) => setStartTime(e.target.value)} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.end', 'End')}
            </label>
            <input type="time" lang={timeInputLang} value={endTime}
              onChange={(e) => setEndTime(e.target.value)} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.duration', 'Duration')}
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              onBlur={(e) => applyDuration(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyDuration((e.target as HTMLInputElement).value);
                }
              }}
              placeholder={t('customers.hours.form.durationPlaceholder', '1h · 1.5 · 1:30') as string}
              title={t('customers.hours.form.durationHint',
                'Type a duration to auto-fill End: 1h, 1.5, 1,5 or 1:30') as string}
              className="input w-full" />
          </div>
          <div>
            <label className="block text-xs text-muted-theme mb-1">
              {t('customers.hours.form.rateOverride', 'Rate override')}
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={rateOverride}
              onChange={(e) => setRateOverride(e.target.value)}
              placeholder={customerHourlyRateMinor != null
                ? (customerHourlyRateMinor / 100).toFixed(2)
                : '—'}
              className="input w-full" />
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-xs text-muted-theme mb-1">
            {t('customers.hours.form.note', 'Note / description')}
          </label>
          <textarea rows={2} value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input w-full text-sm"
            placeholder={t('customers.hours.form.notePlaceholder',
              'What was worked on?') as string} />
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            disabled={createMutation.isPending}
            isLoading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {t('customers.hours.form.save', 'Add entry')}
          </Button>
        </div>
      </div>
      )}

      {/* Bill-these-hours button for per-event customers only. Stays
          visible in compact mode so the customer-detail page can
          still trigger the on-demand billing action. */}
      {!isMonthly && unbilledCount > 0 && (
        <div className="mb-4 flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 rounded p-3">
          <span className="text-sm">
            {t('customers.hours.unbilledCount',
              '{{count}} unbilled entries totaling {{total}}',
              {
                count: unbilledCount,
                total: unbilledTotalMajor.toFixed(2),
              })}
          </span>
          <Button
            variant="primary"
            disabled={billMutation.isPending}
            isLoading={billMutation.isPending}
            onClick={() => billMutation.mutate()}
          >
            {t('customers.hours.billButton', 'Create draft invoice')}
          </Button>
        </div>
      )}

      {/* Entry list table. */}
      {isLoading ? (
        <p className="text-sm text-muted-theme">{t('common.loading', 'Loading…')}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-theme">
          {t('customers.hours.empty', 'No entries logged yet.')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-theme">
                <th className="py-2 pr-3">{t('customers.hours.col.date', 'Date')}</th>
                <th className="py-2 pr-3">{t('customers.hours.col.range', 'Time')}</th>
                <th className="py-2 pr-3 text-right">{t('customers.hours.col.hours', 'Hours')}</th>
                <th className="py-2 pr-3 text-right">{t('customers.hours.col.rate', 'Rate')}</th>
                <th className="py-2 pr-3 text-right">{t('customers.hours.col.total', 'Total')}</th>
                <th className="py-2 pr-3">{t('customers.hours.col.note', 'Note')}</th>
                <th className="py-2 pr-3">{t('customers.hours.col.status', 'Status')}</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const rate = e.hourlyRateMinorOverride ?? customerHourlyRateMinor ?? 0;
                const hours = e.durationMinutes / 60;
                const total = (hours * rate) / 100;
                const locked = isLocked(e);
                return (
                  <tr key={e.id} className="border-t border-neutral-200 dark:border-neutral-700">
                    <td className="py-1.5 pr-3 tabular-nums">{fmtDate(e.entryDate)}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{fmtTime(e.startTime)}–{fmtTime(e.endTime)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{hours.toFixed(2)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{(rate / 100).toFixed(2)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{total.toFixed(2)}</td>
                    <td className="py-1.5 pr-3 max-w-xs truncate" title={e.description || ''}>
                      {e.description || '—'}
                    </td>
                    <td className="py-1.5 pr-3">
                      {e.status === 'billed' ? (
                        <span className="text-xs text-green-700 dark:text-green-300">
                          {e.invoiceNumber
                            ? t('customers.hours.status.billedOn',
                              'Billed: {{number}}', { number: e.invoiceNumber })
                            : t('customers.hours.status.billed', 'Billed')}
                        </span>
                      ) : (
                        <span className="text-xs text-amber-700 dark:text-amber-300">
                          {t('customers.hours.status.unbilled', 'Unbilled')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <button
                        type="button"
                        disabled={locked || deleteMutation.isPending}
                        onClick={() => {
                          if (window.confirm(t('customers.hours.confirmDelete',
                            'Delete this entry? If it has been billed onto a draft, the matching invoice line will also be removed.') as string)) {
                            deleteMutation.mutate(e.id);
                          }
                        }}
                        className="text-xs text-red-600 hover:underline disabled:text-neutral-400 disabled:cursor-not-allowed"
                        title={locked ? t('customers.hours.locked',
                          'Locked: invoice already armed for send') as string : undefined}
                      >
                        {t('common.delete', 'Delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};

export default HoursSection;

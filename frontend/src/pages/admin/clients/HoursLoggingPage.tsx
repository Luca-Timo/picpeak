/**
 * /admin/clients/hours — standalone time-logging surface.
 *
 * Lives below the Invoices sub-nav entry, gated by the `hoursLogging`
 * master feature flag. Admin picks any customer that has the
 * per-customer `feature_hours_logging` toggle on, then logs entries
 * via the shared HoursSection component. For monthly-mode customers
 * entries auto-append to the running monthly draft; for per-event
 * customers a "Bill these hours" button mints a standalone invoice
 * (both behaviours live inside HoursSection — this page is just the
 * customer picker on top).
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, Loading } from '../../../components/common';
import { HoursSection } from '../../../components/admin/HoursSection';
import { customerAdminService } from '../../../services/customerAdmin.service';

export const HoursLoggingPage: React.FC = () => {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Pull the full customer list and filter client-side. The backend
  // listCustomers doesn't currently accept a feature filter — the
  // list is small enough that filtering in JS is fine, and we'd
  // need the per-customer rate / cadence anyway to pass into
  // HoursSection.
  const { data: customers = [], isLoading } = useQuery({
    queryKey: ['admin-customers-list-for-hours'],
    queryFn: () => customerAdminService.list(),
  });

  const eligible = useMemo(
    () => customers.filter((c) => c.featureHoursLogging === true),
    [customers],
  );

  const selectedSummary = useMemo(
    () => eligible.find((c) => c.id === selectedId) || null,
    [eligible, selectedId],
  );

  // Fetch the full customer record once a selection is made — the
  // summary doesn't carry billingCadence, and the HoursSection's
  // monthly-vs-per-event hint copy needs it. Cached so a re-select
  // of the same customer hits memory.
  const { data: selectedDetail } = useQuery({
    queryKey: ['admin-customer', selectedId],
    queryFn: () => customerAdminService.get(selectedId as number),
    enabled: !!selectedId,
  });

  if (isLoading) return <Loading />;

  return (
    <div className="container py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-theme">
              {t('hoursLogging.title', 'Hours logging')}
            </h1>
            {/* Beta badge — matches Customers + Quotes + Contracts +
                Invoices so the whole /admin/clients tab reads as one
                product. */}
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title="Beta — feature is functional but still evolving"
            >
              {t('navigation.betaTag', 'Beta')}
            </span>
          </div>
          <p className="text-sm text-muted-theme mt-1">
            {t('hoursLogging.subtitle',
              'Pick a customer and log billable time blocks. Entries flow into the next monthly bill or are billed on demand for per-event customers.')}
          </p>
        </div>
      </div>

      <Card padding="lg">
        <label className="block text-sm font-medium text-theme mb-1">
          {t('hoursLogging.pickCustomer', 'Customer')}
        </label>
        <select
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
          className="input w-full md:w-96"
        >
          <option value="">{t('hoursLogging.pickPlaceholder', '— Select customer —')}</option>
          {eligible.map((c) => (
            <option key={c.id} value={c.id}>
              {c.companyName || c.displayName
                || [c.firstName, c.lastName].filter(Boolean).join(' ')
                || c.email}
            </option>
          ))}
        </select>
        {eligible.length === 0 && (
          <p className="text-xs text-muted-theme mt-2">
            {t('hoursLogging.emptyList',
              'No customers have hours logging enabled yet. Flip "Hours logging" on a customer\'s detail page first.')}
          </p>
        )}
      </Card>

      {selectedSummary && (
        <HoursSection
          customerId={selectedSummary.id}
          customerHourlyRateMinor={selectedDetail?.hourlyRateMinor ?? selectedSummary.hourlyRateMinor ?? null}
          billingCadence={(selectedDetail?.billingCadence as any) || 'per_event'}
        />
      )}
    </div>
  );
};

export default HoursLoggingPage;

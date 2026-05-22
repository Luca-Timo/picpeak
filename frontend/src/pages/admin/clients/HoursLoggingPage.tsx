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
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card } from '../../../components/common';
import { HoursSection } from '../../../components/admin/HoursSection';
import {
  CustomerPicker,
  type CustomerSummary,
} from '../../../components/admin/CustomerPicker';
import {
  customerAdminService,
  type CustomerAccountDetail,
} from '../../../services/customerAdmin.service';

export const HoursLoggingPage: React.FC = () => {
  const { t } = useTranslation();

  // Picker state mirrors the contract from CustomerPicker — parent owns
  // the id + display label + passive flag triple. This makes the page
  // consistent with the Quote / Bill / Contract editors (#9) instead of
  // the old plain <select> that scrolled through ALL customers.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [customerLabel, setCustomerLabel] = useState('');
  const [customerIsPassive, setCustomerIsPassive] = useState(false);
  // Tracks the picked customer's hour-logging eligibility so the
  // HoursSection only renders for eligible customers (matches the
  // calendar drag-create modal's guard).
  const [customerHoursAllowed, setCustomerHoursAllowed] = useState(true);

  // Fetch the full customer record once a selection is made — needed
  // for billingCadence + hourlyRateMinor.
  const { data: selectedDetail } = useQuery({
    queryKey: ['admin-customer', selectedId],
    queryFn: () => customerAdminService.get(selectedId as number),
    enabled: !!selectedId,
  });

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
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
        <label className="block text-sm font-medium text-theme mb-2">
          {t('hoursLogging.pickCustomer', 'Customer')}
        </label>
        <CustomerPicker
          value={selectedId}
          label={customerLabel}
          isPassive={customerIsPassive}
          requireFeature="hoursLogging"
          onSelect={(c: CustomerSummary) => {
            setSelectedId(c.id);
            setCustomerLabel(
              c.companyName
                || [c.firstName, c.lastName].filter(Boolean).join(' ')
                || c.displayName
                || c.email
                || `#${c.id}`,
            );
            setCustomerIsPassive(Boolean(c.isPassive));
            setCustomerHoursAllowed(c.featureHoursLogging !== false);
          }}
          onCreate={(c: CustomerAccountDetail) => {
            setSelectedId(c.id);
            setCustomerLabel(c.companyName || c.displayName || c.email || `#${c.id}`);
            setCustomerIsPassive(Boolean(c.isPassive));
            setCustomerHoursAllowed(c.featureHoursLogging !== false);
          }}
          onClear={() => {
            setSelectedId(null);
            setCustomerLabel('');
            setCustomerIsPassive(false);
            setCustomerHoursAllowed(true);
          }}
          searchPlaceholder={t('hoursLogging.searchPlaceholder',
            'Search by email or company…') as string}
        />
        {selectedId && !customerHoursAllowed && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            {t('hoursLogging.customerLoggingDisabled',
              "This customer has hour logging disabled. Enable it on the customer's detail page to log hours.")}
          </p>
        )}
      </Card>

      {selectedId && customerHoursAllowed && (
        <HoursSection
          customerId={selectedId}
          customerHourlyRateMinor={selectedDetail?.hourlyRateMinor ?? null}
          billingCadence={(selectedDetail?.billingCadence as any) || 'per_event'}
        />
      )}
    </div>
  );
};

export default HoursLoggingPage;

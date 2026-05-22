import React from 'react';
import {
  ToggleRight,
  Save,
  AlertCircle,
  Images,
  BellRing,
  MessageSquare,
  CalendarDays,
  FileSignature,
  ScrollText,
  Receipt,
  BarChart3,
  Users,
  UserCog,
  Briefcase,
  Wrench,
  Calculator,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../../../components/common';
import { FeatureCard } from '../components/FeatureCard';
import { SidebarPreview } from '../components/SidebarPreview';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import type { FeatureStatus } from '../components/StatusBadge';

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, children }) => (
  <section className="mt-6 first:mt-0">
    <h3 className="px-1 mb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
      {title}
    </h3>
    <ul className="space-y-3">{children}</ul>
  </section>
);

export const FeaturesTab: React.FC = () => {
  const { t } = useTranslation();
  const { staged, setFlag, save, reset, isDirty, isSaving } = useFeatureFlags();

  // The localized label shown in StatusBadge — short, uppercased internally.
  const statusLabel = (status: FeatureStatus): string => {
    const map: Record<FeatureStatus, string> = {
      stable: t('settings.features.status.stable', 'stable'),
      beta: t('settings.features.status.beta', 'beta'),
      new: t('settings.features.status.new', 'new'),
      experimental: t('settings.features.status.experimental', 'experimental'),
      roadmap: t('settings.features.status.roadmap', 'roadmap'),
    };
    return map[status];
  };

  // Localized "no sidebar item" caption used by the Reminder Emails card.
  const sidebarHiddenLabel = t(
    'settings.features.sidebarHidden',
    'No sidebar item — runs in the background',
  );

  // "Coming soon" lock reason for unbuilt features. Keep wording neutral —
  // we don't promise a release date.
  const NOT_YET_AVAILABLE = t(
    'settings.features.notYetAvailable',
    'Not yet available — this toggle activates when the feature ships.',
  );

  return (
    <div className="space-y-6">
      <Card padding="md">
        {/* Header */}
        <div className="mb-6 pb-4 border-b border-neutral-200 dark:border-neutral-700">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent-soft text-on-accent-soft flex items-center justify-center">
              <ToggleRight className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {t('settings.features.title', 'Features')}
              </h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-0.5 max-w-2xl">
                {t(
                  'settings.features.intro',
                  'Turn product surfaces on or off. Enabled features appear in the left navigation and become available to your team. Some features are still in beta — flip them on to try them, off to hide them.',
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Core */}
        <Section title={t('settings.features.sections.core', 'Core')}>
          <FeatureCard
            icon={Images}
            title={t('settings.features.galleries.title', 'Galleries')}
            description={t(
              'settings.features.galleries.description',
              'The core PicPeak surface. Always available.',
            )}
            status="stable"
            statusLabel={statusLabel('stable')}
            sidebarLabel={t('navigation.events')}
            enabled={staged.galleries}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={t(
              'settings.features.galleries.locked',
              "Galleries are the foundation of PicPeak and can't be turned off.",
            )}
          />
        </Section>

        {/* Clients (#354 follow-up). Visual grouping for the CRM-area
            sub-features. The "Clients" sidebar section itself is gated
            by a derived `clients` flag (computed from whether any
            child below is on), so there's no explicit parent toggle —
            admins just enable the specific feature they want and the
            section appears automatically. */}
        <Section title={t('settings.features.sections.clients', 'CRM')}>
          <FeatureCard
            icon={UserCog}
            title={t('settings.features.customerPortal.title', 'Customer Accounts')}
            description={t(
              'settings.features.customerPortal.description',
              'Persistent customer logins. Recurring clients see all their assigned galleries from one place — no per-event passwords. Customers log in at /customer/login and you manage them under Clients → Accounts.',
            )}
            status="beta"
            statusLabel={statusLabel('beta')}
            // Sidebar hint mirrors the top-level "Clients" entry the
            // admin clicks first, not the deeper "Accounts" sub-nav.
            // Keeps the wording consistent with what's actually visible
            // in the menu bar.
            sidebarLabel={t('navigation.clients', 'CRM')}
            enabled={staged.customerPortal}
            onToggle={(next) => setFlag('customerPortal', next)}
          />
          {/* Future sub-features (Calendar / Quotes / Bills / Messaging)
              slot in here as FeatureCard entries when they ship. No
              placeholder cards today — the Clients section just shows
              what's actually built. */}
        </Section>

        {/* Communication */}
        <Section title={t('settings.features.sections.communication', 'Communication')}>
          <FeatureCard
            icon={BellRing}
            title={t('settings.features.reminderEmails.title', 'Reminder Emails')}
            description={t(
              'settings.features.reminderEmails.description',
              'Automatic nudges to guests before their gallery expires and to admins about pending uploads. Coming soon.',
            )}
            status="roadmap"
            statusLabel={statusLabel('roadmap')}
            sidebarHidden
            sidebarHiddenLabel={sidebarHiddenLabel}
            enabled={staged.reminderEmails}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={NOT_YET_AVAILABLE}
          />

          <FeatureCard
            icon={MessageSquare}
            title={t('settings.features.messaging.title', 'Messaging')}
            description={t(
              'settings.features.messaging.description',
              'In-app threads with guests, attached to a gallery. Email is genuinely fine for most teams — this is for studios that want everything in one place. Coming soon.',
            )}
            status="roadmap"
            statusLabel={statusLabel('roadmap')}
            sidebarLabel={t('settings.features.messaging.sidebar', 'Messages')}
            enabled={staged.messaging}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={NOT_YET_AVAILABLE}
          />
        </Section>

        {/* Scheduling */}
        <Section title={t('settings.features.sections.scheduling', 'Scheduling')}>
          <FeatureCard
            icon={CalendarDays}
            title={t('settings.features.calendar.title', 'Calendar')}
            description={t(
              'settings.features.calendar.description',
              'Admin-only calendar showing events, logged hours, and pending quotes/contracts in one view. Drag-create hours directly on the calendar.',
            )}
            status="new"
            statusLabel={statusLabel('new')}
            sidebarLabel={t('settings.features.calendar.sidebar', 'Calendar')}
            enabled={staged.calendar}
            onToggle={(next) => setFlag('calendar', next)}
          />
          {/* Customer-facing booking — placeholder. UI-disabled per
              spec; backend dependency rule already gates it on
              `calendar`. Re-enable when the booking flow ships. */}
          <FeatureCard
            icon={CalendarDays}
            title={t('settings.features.calendarBooking.title', 'Customer booking')}
            description={t(
              'settings.features.calendarBooking.description',
              'Let customers see free slots on a public calendar and book directly. Coming soon.',
            )}
            status="roadmap"
            statusLabel={statusLabel('roadmap')}
            sidebarLabel={t('settings.features.calendarBooking.sidebar', 'Booking')}
            enabled={staged.calendarBooking}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={NOT_YET_AVAILABLE}
          />
        </Section>

        {/* Sales */}
        <Section title={t('settings.features.sections.sales', 'Sales')}>
          {/* Quotes + Bills shipped in the CRM PR (#TBD). The old
              placeholder lockedReason / disabled props are removed so
              the toggles actually save. The sub-page surfaces under
              /admin/clients/{quotes,bills} are gated independently. */}
          <FeatureCard
            icon={FileSignature}
            title={t('settings.features.quotes.title', 'Quotes')}
            description={t(
              'settings.features.quotes.description',
              'Send line-itemed quotes to clients. They can accept or decline from a public link; payment is tracked manually.',
            )}
            status="new"
            statusLabel={statusLabel('new')}
            sidebarLabel={t('settings.features.quotes.sidebar', 'Quotes')}
            enabled={staged.quotes}
            onToggle={(next) => setFlag('quotes', next)}
          />

          <FeatureCard
            icon={ScrollText}
            title={t('settings.features.contracts.title', 'Contracts')}
            description={t(
              'settings.features.contracts.description',
              'Compose contracts from a library of reusable blocks (image rights, NDA, model release, cancellation, jurisdiction…) and have customers sign in-browser or upload a wet-signed PDF. Seeded block bodies are EXAMPLES ONLY — review with your lawyer before sending.',
            )}
            status="new"
            statusLabel={statusLabel('new')}
            sidebarLabel={t('settings.features.contracts.sidebar', 'Contracts')}
            enabled={staged.contracts}
            onToggle={(next) => setFlag('contracts', next)}
          />

          <FeatureCard
            icon={Receipt}
            title={t('settings.features.bills.title', 'Invoices')}
            description={t(
              'settings.features.bills.description',
              'Generate an invoice from any accepted quote. Mark paid manually — no payment processor integration.',
            )}
            status="new"
            statusLabel={statusLabel('new')}
            sidebarLabel={t('settings.features.bills.sidebar', 'Invoices')}
            enabled={staged.bills}
            onToggle={(next) => setFlag('bills', next)}
          />

          <FeatureCard
            icon={Calculator}
            title={t('settings.features.taxReport.title', 'Tax report')}
            description={t(
              'settings.features.taxReport.description',
              'Period-scoped revenue list with net + VAT breakdown grouped by VAT rate. Export as PDF (landscape, company letterhead) or CSV for your accountant. Cancelled invoices stay visible for a gap-free audit trail but are excluded from totals.',
            )}
            status="new"
            statusLabel={statusLabel('new')}
            sidebarLabel={t('settings.features.taxReport.sidebar', 'Tax')}
            enabled={staged.taxReport}
            onToggle={(next) => setFlag('taxReport', next)}
            disabled={!staged.bills}
            lockedReason={!staged.bills ? t(
              'settings.features.taxReport.requiresBills',
              'Enable Bills first — the tax report reads from your invoices.',
            ) : undefined}
          />

          <FeatureCard
            icon={Briefcase}
            title={t('settings.features.hoursLogging.title', 'Hours logging')}
            description={t(
              'settings.features.hoursLogging.description',
              'Per-customer time tracking. Admin logs date + start/end times + optional rate override + note. Monthly-mode customers auto-accumulate hours into the running monthly draft; per-event customers see a "Create draft invoice" button that mints a standalone draft invoice with one line per entry. Independent of Bills — log hours even before turning the full billing surface on.',
            )}
            status="new"
            statusLabel={statusLabel('new')}
            sidebarLabel={t('settings.features.hoursLogging.sidebar', 'Hours')}
            enabled={staged.hoursLogging}
            onToggle={(next) => setFlag('hoursLogging', next)}
          />
        </Section>

        {/* Insights & Access */}
        <Section title={t('settings.features.sections.insights', 'Insights & Access')}>
          <FeatureCard
            icon={BarChart3}
            title={t('settings.features.analytics.title', 'Analytics')}
            description={t(
              'settings.features.analytics.description',
              'Storage usage, gallery views, download counts, and per-event stats.',
            )}
            status="stable"
            statusLabel={statusLabel('stable')}
            sidebarLabel={t('admin.analytics', 'Analytics')}
            enabled={staged.analytics}
            onToggle={(next) => setFlag('analytics', next)}
          />

          <FeatureCard
            icon={Users}
            title={t('settings.features.userManagement.title', 'User Management')}
            description={t(
              'settings.features.userManagement.description',
              "Multi-admin support with role-based permissions. Turn off if you're a single-operator studio.",
            )}
            status="stable"
            statusLabel={statusLabel('stable')}
            sidebarLabel={t('navigation.users', 'Users')}
            enabled={staged.userManagement}
            onToggle={(next) => setFlag('userManagement', next)}
            warning={t(
              'settings.features.userManagement.warning',
              'Existing user accounts stay valid; the admin UI for managing them will be hidden until you re-enable this.',
            )}
          />

          <FeatureCard
            icon={Wrench}
            title={t('settings.features.crmDevelopment.title', 'CRM developer tools')}
            description={t(
              'settings.features.crmDevelopment.description',
              'Internal helpers for verifying CRM flows (e.g. fire the admin payment-check email instantly, bypass throttles). Surfaces as a "Development" sub-tab under Clients. Strictly opt-in — fires real side effects, use against test data only.',
            )}
            status="experimental"
            statusLabel={statusLabel('experimental')}
            sidebarLabel={t('settings.features.crmDevelopment.sidebar', 'Development')}
            enabled={staged.crmDevelopment}
            onToggle={(next) => setFlag('crmDevelopment', next)}
          />
        </Section>
      </Card>

      <SidebarPreview staged={staged} />

      {/* Save bar */}
      <div className="flex items-center justify-end gap-2 pt-2">
        {isDirty && (
          <span className="mr-auto text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {t('settings.features.unsavedChanges', 'You have unsaved changes')}
          </span>
        )}
        <Button variant="outline" disabled={!isDirty || isSaving} onClick={reset}>
          {t('common.discard', 'Discard')}
        </Button>
        <Button
          variant="primary"
          disabled={!isDirty || isSaving}
          isLoading={isSaving}
          onClick={() => { void save(); }}
          leftIcon={<Save className="w-4 h-4" />}
        >
          {t('common.saveChanges', 'Save changes')}
        </Button>
      </div>
    </div>
  );
};

import { api } from '../config/api';

export type FeatureKey =
  | 'galleries'
  | 'reminderEmails'
  | 'calendar'
  | 'calendarBooking'
  | 'quotes'
  | 'bills'
  | 'messaging'
  | 'analytics'
  | 'userManagement'
  // Top-level "Clients" section (#354 follow-up). Parent flag that
  // gates the /admin/clients/* sidebar entry. customerPortal,
  // calendar, quotes, bills and messaging are conceptually its
  // children — when `clients` is off none of them surface in the
  // admin UI even if their individual flags are on.
  | 'clients'
  // Customer-side portal surface (#354). Gates /customer/* routes
  // (login, dashboard, profile, accept-invite, reset-password) and
  // the Accounts sub-page under Clients in the admin UI.
  | 'customerPortal'
  // CRM developer tools — hidden by default. When enabled, surfaces
  // a "Development" sub-tab under Clients with internal-use buttons
  // (test the payment-check email flow, fire dev-only side effects,
  // etc.). Strictly opt-in; toggled from Features.
  | 'crmDevelopment'
  // Tax / Steuer report — period-scoped revenue export under
  // Clients. Independent of `bills` so admins who already use the
  // billing surface don't get a new menu entry automatically; they
  // opt in when they're ready to generate tax reports.
  | 'taxReport'
  // Hours logging (migration 129). Master switch for the per-customer
  // Hours card on the customer detail page. Independent of `bills`
  // so admin can log hours without enabling the broader billing
  // surface yet.
  | 'hoursLogging'
  // Contracts (migration 130). Standalone legal-document type alongside
  // quotes / bills, composed from a library of reusable blocks and
  // signed in-browser (canvas + checkbox) or via wet-signed PDF
  // upload. Independent of quotes / bills — contracts can be sent on
  // their own. Seeded block bodies are examples only; admins must
  // have their lawyer review before sending. See docs/crm-disclaimers.md.
  | 'contracts';

export type FeatureFlags = Record<FeatureKey, boolean>;

export const featureFlagsService = {
  async get(): Promise<FeatureFlags> {
    const response = await api.get<FeatureFlags>('/admin/feature-flags');
    return response.data;
  },

  async update(flags: Partial<FeatureFlags>): Promise<FeatureFlags> {
    const response = await api.put<FeatureFlags>('/admin/feature-flags', flags);
    return response.data;
  },
};

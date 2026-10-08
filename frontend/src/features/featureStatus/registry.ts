import type { FeatureKey } from '../../services/featureFlags.service';

/**
 * How far along each feature is — the one list the Features page, the
 * feature's own page header and the customer record read (STYLING.md ›
 * Feature state). Change a feature's state here and nowhere else.
 *
 * - `stable`        done; no label. With `newSince` it shows **New** for
 *                   NEW_FOR_DAYS days after that date, then nothing.
 * - `beta`          in development: usable for real work, may still change.
 * - `experimental`  may break or go away; not for a production studio.
 * - `roadmap`       not built yet; its toggle stays locked.
 */
export type FeatureMaturity = 'stable' | 'beta' | 'experimental' | 'roadmap';

/** What is shown: the maturity, or `new` while a stable feature is fresh. */
export type FeatureState = FeatureMaturity | 'new';

export interface FeatureStatusEntry {
  maturity: FeatureMaturity;
  /** YYYY-MM-DD the feature became stable; drives the New label. */
  newSince?: string;
}

/** Customer-portal tabs that are not features of their own. */
export type PortalFeatureKey = 'portalCalendar';

export const NEW_FOR_DAYS = 30;

// Every feature that carried a "new" label before the labels were unified
// counts as new from the day that change was merged.
const UNIFIED_LABELS_MERGED = '2026-10-08';

export const FEATURE_STATUS: Record<FeatureKey | PortalFeatureKey, FeatureStatusEntry> = {
  // Core
  galleries: { maturity: 'stable' },
  slideshow: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  transfers: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  faces: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  // Automation
  workflows: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  // CRM
  clients: { maturity: 'stable' },
  customerPortal: { maturity: 'beta' },
  documents: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  calendar: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  calendarBooking: { maturity: 'roadmap' },
  quotes: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  contracts: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  bills: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  newsletters: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  hoursLogging: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  projects: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  crmDevelopment: { maturity: 'experimental' },
  // Communication
  reminderEmails: { maturity: 'beta' },
  incomingMail: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  whatsapp: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  messaging: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  // Accounting
  accounting: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  taxReport: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  incomingInvoices: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  expenses: { maturity: 'stable', newSince: UNIFIED_LABELS_MERGED },
  // Insights & access
  analytics: { maturity: 'stable' },
  userManagement: { maturity: 'stable' },
  // Customer portal tabs
  portalCalendar: { maturity: 'roadmap' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The state to show for a feature today. */
export function featureState(key: FeatureKey | PortalFeatureKey, now: Date = new Date()): FeatureState {
  const entry = FEATURE_STATUS[key];
  if (!entry) return 'stable';
  if (entry.maturity !== 'stable' || !entry.newSince) return entry.maturity;
  const since = Date.parse(`${entry.newSince}T00:00:00`);
  if (Number.isNaN(since)) return 'stable';
  return now.getTime() < since + NEW_FOR_DAYS * DAY_MS ? 'new' : 'stable';
}

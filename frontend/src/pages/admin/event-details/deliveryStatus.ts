/**
 * How close a two-stage delivery is to its promised date (issue 1562), shared
 * by the Delivery settings, the event header and the event list so all three
 * colour a gallery the same way: amber within two days, red once overdue.
 */
export interface DeliveryDue {
  date: Date;
  /** Whole days left; negative once overdue. */
  days: number;
  tone: 'ok' | 'soon' | 'overdue';
}

const DAY_MS = 864e5;
export const DUE_SOON_DAYS = 2;

export function deliveryDue(dueAt: string | null | undefined, now: Date = new Date()): DeliveryDue | null {
  if (!dueAt) return null;
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.ceil((date.getTime() - now.getTime()) / DAY_MS);
  const tone = date.getTime() <= now.getTime() ? 'overdue' : days <= DUE_SOON_DAYS ? 'soon' : 'ok';
  return { date, days, tone };
}

/** True while the gallery shows a first look and waits for the rest. */
export const isAwaitingFullGallery = (event: { delivery_status?: string | null }) => event.delivery_status === 'partial';

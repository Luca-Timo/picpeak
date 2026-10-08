import { describe, it, expect } from 'vitest';
import { FEATURE_STATUS, NEW_FOR_DAYS, featureState } from '../registry';

describe('featureState', () => {
  const since = FEATURE_STATUS.quotes.newSince as string;
  const day = (offset: number) => new Date(Date.parse(`${since}T00:00:00`) + offset * 86_400_000 + 3_600_000);

  it('shows a stable feature as new for 30 days after its date, then as stable', () => {
    expect(NEW_FOR_DAYS).toBe(30);
    expect(featureState('quotes', day(0))).toBe('new');
    expect(featureState('quotes', day(29))).toBe('new');
    expect(featureState('quotes', day(30))).toBe('stable');
  });

  it('keeps beta, experimental and roadmap whatever the date', () => {
    expect(featureState('customerPortal', day(400))).toBe('beta');
    expect(featureState('crmDevelopment', day(400))).toBe('experimental');
    expect(featureState('calendarBooking', day(400))).toBe('roadmap');
    expect(featureState('portalCalendar', day(400))).toBe('roadmap');
  });

  it('never labels a stable feature without a date', () => {
    expect(featureState('galleries')).toBe('stable');
  });
});

import { describe, expect, it } from 'vitest';
import { changedKeys, dateRangeError, draftError, draftFromProject, fieldsFromDraft, guestCountError, rebaseDraft, updatePayload } from '../projectDraft';

const saved = draftFromProject({
  eventType: 'wedding', eventDate: '2027-06-12', eventEndDate: null, location: 'Schloss Vaduz',
  guestCount: 120, budgetMinor: 450000, currency: 'CHF', source: 'referral', notes: 'Trauung 14 Uhr',
});

describe('project draft', () => {
  it('reads the budget in major units and back in minor units', () => {
    expect(saved.budget).toBe(4500);
    expect(fieldsFromDraft({ ...saved, budget: 4500.5 }).budgetMinor).toBe(450050);
  });

  it('turns cleared inputs into null', () => {
    const fields = fieldsFromDraft({ ...saved, location: '  ', guestCount: '', budget: 0, notes: '' });
    expect(fields).toMatchObject({ location: null, guestCount: null, budgetMinor: null, notes: null });
  });

  it('sends only what changed, so an untouched draft writes nothing', () => {
    expect(updatePayload(saved, saved)).toEqual({});
    expect(updatePayload({ ...saved, guestCount: '140', location: '' }, saved)).toEqual({ guestCount: 140, location: null });
  });

  it('does not count whitespace around a value as a change', () => {
    expect(changedKeys({ ...saved, location: ' Schloss Vaduz ' }, saved)).toEqual([]);
  });

  it('keeps the admin\'s edits and takes everyone else\'s on a refetch', () => {
    const edited = { ...saved, guestCount: '140' };
    const newBase = { ...saved, location: 'Triesen', guestCount: '125' };
    expect(rebaseDraft(edited, saved, newBase)).toMatchObject({ guestCount: '140', location: 'Triesen' });
  });

  it('flags an end date before the start date', () => {
    expect(dateRangeError({ ...saved, eventEndDate: '2027-06-11' })).toBe(true);
    expect(dateRangeError({ ...saved, eventEndDate: '2027-06-13' })).toBe(false);
    expect(dateRangeError({ ...saved, eventDate: '', eventEndDate: '2027-06-11' })).toBe(false);
  });

  it('flags more guests than the API takes instead of sending them', () => {
    expect(guestCountError({ ...saved, guestCount: '100001' })).toBe(true);
    expect(guestCountError({ ...saved, guestCount: '100000' })).toBe(false);
    expect(guestCountError({ ...saved, guestCount: '' })).toBe(false);
    expect(draftError({ ...saved, guestCount: '100001' })).toBe('tooManyGuests');
    expect(draftError({ ...saved, eventEndDate: '2027-06-11' })).toBe('endBeforeStart');
    expect(draftError(saved)).toBeNull();
  });
});

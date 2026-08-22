/**
 * The photographer's own stars and colour labels (#1044 follow-up).
 *
 * The property that matters most here is isolation: admin marks live in their
 * own table precisely so they can never reach a guest-facing surface. Pinned:
 *
 *  - rating and colour are independent halves of one mark — writing one must
 *    not wipe the other
 *  - a mark with neither half left is deleted, not kept as an empty row
 *  - two admins on the same event keep separate marks
 *  - marks never touch photo_feedback or the denormalized photos.* counters
 *    the gallery reads
 *  - invalid values are rejected the same way guest colour labels are
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-marks-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-marks-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const marks = require('../../src/services/photoAdminMarksService');
const feedbackService = require('../../src/services/feedbackService');

const ADMIN_A = 11;
const ADMIN_B = 22;

let db;
let cleanup;
let eventId;
let photoIds;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: 'admin-marks-test-event',
    event_type: 'wedding',
    event_name: 'Admin Marks Test',
    event_date: '2026-07-20',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: '/gallery/admin-marks-test-event/share',
    share_token: 'admin-marks-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];

  photoIds = [];
  for (let i = 0; i < 3; i++) {
    const photo = await db('photos').insert({
      event_id: eventId,
      filename: `photo-${i}.jpg`,
      path: `events/admin-marks/${i}.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoIds.push(photo[0]?.id ?? photo[0]);
  }
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('photoAdminMarksService (#1044 follow-up)', () => {
  it('sets a colour without touching the rating, and vice versa', async () => {
    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { colorLabel: 'green' }))
      .toEqual({ rating: null, color_label: 'green' });

    // Writing the rating must leave the colour alone — the two lightbox key
    // groups write independently.
    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { rating: 4 }))
      .toEqual({ rating: 4, color_label: 'green' });

    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { colorLabel: 'red' }))
      .toEqual({ rating: 4, color_label: 'red' });
  });

  it('keeps exactly one row per photo per admin', async () => {
    const rows = await db('photo_admin_marks')
      .where({ photo_id: photoIds[0], admin_id: ADMIN_A });
    expect(rows).toHaveLength(1);
  });

  it('clears one half with null and leaves the other', async () => {
    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { colorLabel: null }))
      .toEqual({ rating: 4, color_label: null });
  });

  it('deletes the row once neither half is left', async () => {
    expect(await marks.setMark(eventId, photoIds[0], ADMIN_A, { rating: null })).toBeNull();
    const rows = await db('photo_admin_marks')
      .where({ photo_id: photoIds[0], admin_id: ADMIN_A });
    expect(rows).toHaveLength(0);
  });

  it('keeps two admins on the same photo independent', async () => {
    await marks.setMark(eventId, photoIds[1], ADMIN_A, { colorLabel: 'green' });
    await marks.setMark(eventId, photoIds[1], ADMIN_B, { colorLabel: 'red', rating: 2 });

    expect((await marks.getEventMarks(eventId, ADMIN_A))[photoIds[1]])
      .toEqual({ rating: null, color_label: 'green' });
    expect((await marks.getEventMarks(eventId, ADMIN_B))[photoIds[1]])
      .toEqual({ rating: 2, color_label: 'red' });
  });

  it('rejects colours outside the set and ratings outside 1-5', async () => {
    await expect(marks.setMark(eventId, photoIds[2], ADMIN_A, { colorLabel: 'chartreuse' }))
      .rejects.toThrow('Invalid color label');
    await expect(marks.setMark(eventId, photoIds[2], ADMIN_A, { rating: 6 }))
      .rejects.toThrow('Rating must be between 1 and 5');
    await expect(marks.setMark(eventId, photoIds[2], ADMIN_A, { rating: 0 }))
      .rejects.toThrow('Rating must be between 1 and 5');
    // Nothing was written by any of the rejected calls.
    expect(await marks.getEventMarks(eventId, ADMIN_A, [photoIds[2]])).toEqual({});
  });

  it('narrows to a page of photo ids', async () => {
    expect(Object.keys(await marks.getEventMarks(eventId, ADMIN_A, [photoIds[1]])))
      .toEqual([String(photoIds[1])]);
    expect(await marks.getEventMarks(eventId, ADMIN_A, [])).toEqual({});
  });

  it('counts colours per admin for the filter chips', async () => {
    await marks.setMark(eventId, photoIds[2], ADMIN_A, { colorLabel: 'green' });
    expect(await marks.getEventMarkColorCounts(eventId, ADMIN_A)).toEqual({ green: 2 });
    expect(await marks.getEventMarkColorCounts(eventId, ADMIN_B)).toEqual({ red: 1 });
    // A rating-only mark contributes no colour count.
    await marks.setMark(eventId, photoIds[0], ADMIN_A, { rating: 5 });
    expect(await marks.getEventMarkColorCounts(eventId, ADMIN_A)).toEqual({ green: 2 });
  });

  it('never leaks into guest feedback or the denormalized gallery counters', async () => {
    // Everything above wrote marks on all three photos.
    expect(await db('photo_feedback').count('* as count').first())
      .toEqual(expect.objectContaining({ count: 0 }));

    for (const photoId of photoIds) {
      // updatePhotoFeedbackStats is what the gallery payload reads; it must
      // still see an untouched photo.
      await feedbackService.updatePhotoFeedbackStats(photoId);
      const photo = await db('photos').where('id', photoId).first();
      expect(Number(photo.color_label_count) || 0).toBe(0);
      expect(Number(photo.average_rating) || 0).toBe(0);
      expect(Number(photo.feedback_count) || 0).toBe(0);
    }

    // And the guest-facing tallies stay empty.
    expect(await feedbackService.getPhotoColorLabelCounts(photoIds[1])).toEqual({});
    expect(await feedbackService.getEventColorLabelCounts(eventId)).toEqual({});
  });
});

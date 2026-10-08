/**
 * Emails take their accent from Branding › Colours when Settings → Email sets
 * no Primary colour, and the green the seeded templates carry inline follows
 * that accent (emailProcessor resolveEmailAccent / wrapEmailHtml).
 */

const { bootCrmDb } = require('./helpers/crmDb');

describe('wrapEmailHtml — email accent', () => {
  let db;
  let cleanup;
  let wrapEmailHtml;

  const setSetting = async (key, value) => {
    await db('app_settings').where({ setting_key: key }).del();
    if (value !== undefined) {
      await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'general', updated_at: new Date() });
    }
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ wrapEmailHtml } = require('../../src/services/emailProcessor'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await setSetting('email_primary_color', undefined);
    await setSetting('email_button_text_color', undefined);
    await setSetting('theme_config', { accentDarkColor: '#014E4E' });
  });

  const body = '<div style="border-left: 4px solid #5C8762;">Box</div><a class="button" href="#">Open</a>';

  it('uses the brand filled accent when no email Primary colour is set', async () => {
    const html = await wrapEmailHtml(body, 'Subject', 'en');
    expect(html).toContain('border-left: 4px solid #014E4E');
    expect(html).toContain('background-color:#014E4E');
    expect(html).not.toMatch(/#5c8762/i);
  });

  it('keeps a Primary colour set in Settings → Email, the legacy green included', async () => {
    await setSetting('email_primary_color', '#5C8762');
    const html = await wrapEmailHtml(body, 'Subject', 'en');
    expect(html).toContain('border-left: 4px solid #5C8762');
    expect(html).not.toContain('#014E4E');

    await setSetting('email_primary_color', '#123456');
    expect(await wrapEmailHtml(body, 'Subject', 'en')).toContain('border-left: 4px solid #123456');
  });

  it('picks a readable button label for a light brand colour', async () => {
    await setSetting('theme_config', { accentDarkColor: '#4a90d9' });
    const html = await wrapEmailHtml(body, 'Subject', 'en');
    expect(html).toContain('background-color:#4a90d9');
    expect(html).not.toContain('color:#ffffff;display:inline-block');
  });

  it('keeps the legacy green for a brand colour too pale for the white card, as PDFs keep black', async () => {
    await setSetting('theme_config', { accentDarkColor: '#ffe066' });
    const html = await wrapEmailHtml(body, 'Subject', 'en');
    expect(html).toContain('background-color:#5C8762');
  });
});

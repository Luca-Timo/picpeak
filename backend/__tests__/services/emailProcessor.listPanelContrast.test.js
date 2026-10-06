/**
 * The info panel (<ul>) in wrapEmailHtml had a background colour but no text
 * colour, so its text inherited the body text colour. A dark email palette
 * with a light info panel rendered near-white text on a near-white box in
 * every list-bearing mail (pre-event reminder, gallery delivery, ...).
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');

const COLOR_KEYS = [
  'email_primary_color', 'email_secondary_color', 'email_body_bg_color',
  'email_container_bg_color', 'email_list_bg_color', 'email_body_text_color',
  'email_muted_text_color', 'email_button_text_color',
];

describe('wrapEmailHtml — info panel text stays readable', () => {
  let db; let cleanup; let wrapEmailHtml; let upsertAppSetting;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ wrapEmailHtml } = require('../../src/services/emailProcessor'));
    ({ upsertAppSetting } = require('../../src/utils/appSettings'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  async function setColors(values) {
    await db('app_settings').whereIn('setting_key', COLOR_KEYS).del();
    for (const [key, value] of Object.entries(values)) {
      await upsertAppSetting(key, JSON.stringify(value), 'string');
    }
  }

  const BODY = '<p>Hi</p><ul>\n  <li>One <strong>bold</strong></li>\n</ul>';

  it('uses a dark neutral for list text on a light panel in a dark palette', async () => {
    await setColors({
      email_container_bg_color: '#1c1c1c',
      email_body_text_color: '#e5e5e5',
      email_list_bg_color: '#f5f5f5',
    });
    const html = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(html).toMatch(/\.email-content ul \{\s*background-color: #f5f5f5;\s*color: #333333;/);
    expect(html).toMatch(/\.email-content ul strong \{\s*color: #333333;/);
    expect(html).toContain('<ul style="background-color:#f5f5f5;color:#333333;');
    // Paragraph text keeps the admin's colour.
    expect(html).toContain('color:#e5e5e5;');
  });

  it('keeps the body text colour when it already reads on the panel', async () => {
    await setColors({});
    const html = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(html).toContain('<ul style="background-color:#f9f9f9;color:#333333;');

    await setColors({
      email_container_bg_color: '#1a1a1a',
      email_body_text_color: '#e5e5e5',
      email_list_bg_color: '#242424',
    });
    const dark = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(dark).toContain('<ul style="background-color:#242424;color:#e5e5e5;');
  });

  it('keeps list styling in <style> only when the caller opts out (newsletter body_css)', async () => {
    await setColors({});
    const html = await wrapEmailHtml(BODY, 'Subject', 'en', { inlineListPanels: false });
    expect(html).toContain('<ul>');
    expect(html).not.toContain('<ul style=');
    expect(html).toMatch(/\.email-content ul \{\s*background-color: #f9f9f9;\s*color: #333333;/);
  });

  it('leaves a <ul> the template styled itself alone', async () => {
    await setColors({});
    const html = await wrapEmailHtml('<ul class="x" style="color:red"><li>a</li></ul>', 'Subject', 'en');
    expect(html).toContain('<ul class="x" style="color:red">');
  });
});

/**
 * Migration: CRM — Quotes + Invoices schema, permissions, feature flags.
 *
 * Implements the data layer for the Quotes and Bills sub-pages under
 * /admin/clients. Pure schema + seed; no code paths reference these
 * tables yet (subsequent commits in the same PR wire them up).
 *
 * Tables created (10):
 *   - business_profile               singleton issuer block for PDFs
 *   - business_bank_accounts         1:N — multiple bank accounts per profile
 *   - payment_term_templates         reusable installment plans
 *                                    (4 system rows seeded)
 *   - quote_line_item_presets        reusable building blocks for line items
 *   - quotes                         the master quote record
 *   - quote_line_items               line items (1:N from quote)
 *   - quote_action_tokens            hex tokens for the public accept/decline link
 *   - invoices                       the master invoice record
 *   - invoice_line_items             line items (1:N from invoice)
 *   - invoice_payment_log            audit + partial-payment trail
 *   - event_payment_plans            glue row connecting an event back to its
 *                                    origin quote, capturing the payment plan
 *                                    at acceptance time
 *
 * Extensions to existing tables:
 *   - events.quote_id                FK to quotes(id), nullable, set when an
 *                                    event is created from a converted quote
 *
 * Note on email scheduling: the existing `email_queue.scheduled_at` column
 * (created in db.js boot) is already present; we tighten the processor's
 * pickup query in a later commit. No schema change needed here.
 *
 * RBAC permissions seeded (4):
 *   quotes.view / quotes.manage / bills.view / bills.manage
 *   Granted to super_admin + admin roles. Editor/viewer locked out by
 *   default (matches the customers.* pattern from migration 090).
 *
 * Feature flags seeded (2):
 *   quotes, bills — both default OFF for upgrades. Admin opts in via
 *   Settings → Features. The existing `clients` parent flag plus
 *   `featureFlagsAny: ['customerPortal', 'quotes', 'bills']` on the
 *   sidebar entry (wired in a later commit) keeps the menu visible.
 *
 * Email templates seeded (8):
 *   quote_sent / quote_accepted_admin / quote_declined_admin
 *   invoice_sent / invoice_reminder_first / invoice_reminder_second
 *   invoice_paid_receipt / invoice_cancelled
 *   en + de hand-translated bodies; fr/nl/pt/ru fall through to en
 *   until the admin or a translator overrides them via the Templates
 *   UI (per project memory: machine-translated locales flagged in PR).
 *
 * Money is stored as INTEGER minor units (cents/Rappen) + ISO 4217
 * currency code, never as DECIMAL/FLOAT — avoids floating-point drift on
 * totals. Frontend formats via Intl.NumberFormat.
 *
 * Migration is idempotent — every step checks for existing state.
 */

const SYSTEM_PAYMENT_TERM_TEMPLATES = [
  {
    name: 'Komplettzahlung nach Auslieferung',
    description: 'Zahlbar nach Erhalt der Bilder, ohne Abzüge.',
    net_days: 30,
    skonto_percent: null,
    skonto_within_days: null,
    installments: [
      { label: 'Gesamtbetrag nach Auslieferung', percent: 100, trigger: 'after_delivery', offset_days: 0 },
    ],
    display_order: 10,
  },
  {
    name: 'Komplettzahlung vor Event',
    description: 'Zahlbar 7 Tage vor dem Event.',
    net_days: 30,
    skonto_percent: null,
    skonto_within_days: null,
    installments: [
      { label: 'Gesamtbetrag vor Event', percent: 100, trigger: 'before_event', offset_days: -7 },
    ],
    display_order: 20,
  },
  {
    name: 'Komplettzahlung nach Event',
    description: 'Zahlbar nach dem Event, vor Auslieferung.',
    net_days: 30,
    skonto_percent: null,
    skonto_within_days: null,
    installments: [
      { label: 'Gesamtbetrag nach Event', percent: 100, trigger: 'after_event', offset_days: 0 },
    ],
    display_order: 30,
  },
  {
    name: '3 Raten 30/30/40',
    description: '30% bei Auftragsbestätigung, 30% vor Event, 40% nach Auslieferung.',
    net_days: 30,
    skonto_percent: null,
    skonto_within_days: null,
    installments: [
      { label: 'Anzahlung bei Auftragsbestätigung', percent: 30, trigger: 'quote_accepted', offset_days: 0 },
      { label: 'Teilzahlung vor Event', percent: 30, trigger: 'before_event', offset_days: -7 },
      { label: 'Schlusszahlung nach Auslieferung', percent: 40, trigger: 'after_delivery', offset_days: 0 },
    ],
    display_order: 40,
  },
];

const NEW_PERMISSIONS = [
  { name: 'quotes.view',   display_name: 'View Quotes',          category: 'quotes', description: 'View quotes and their line items' },
  { name: 'quotes.manage', display_name: 'Manage Quotes',        category: 'quotes', description: 'Create, edit, send, duplicate, and convert quotes' },
  { name: 'bills.view',    display_name: 'View Invoices',        category: 'billing', description: 'View invoices and their payment status' },
  { name: 'bills.manage',  display_name: 'Manage Invoices',      category: 'billing', description: 'Create, edit, send invoices, mark them paid, and send reminders' },
];

const NEW_FEATURE_FLAGS = ['quotes', 'bills'];

// CRM sub-function toggles. Live in app_settings, edited from the CRM
// Settings tab (Commit 10). Each one disables a slice of the CRM surface
// without turning off the whole `quotes` / `bills` global flag — so an
// admin can keep the Quotes tab open but turn off Skonto, or keep
// invoices flowing without auto-reminders.
const CRM_SUB_SETTINGS = [
  // Quote behaviour
  { setting_key: 'crm_quotes_pdf_attachment_enabled',     setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_quotes_skonto_enabled',             setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_quotes_accept_window_minutes',      setting_value: 15,    setting_type: 'crm' },
  { setting_key: 'crm_quotes_default_valid_days',         setting_value: 30,    setting_type: 'crm' },
  // Invoice behaviour
  { setting_key: 'crm_invoices_qr_enabled',               setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_invoices_reminders_enabled',        setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_invoices_reminder_first_days',      setting_value: 14,    setting_type: 'crm' },
  { setting_key: 'crm_invoices_reminder_second_days',     setting_value: 30,    setting_type: 'crm' },
  { setting_key: 'crm_invoices_late_fee_enabled',         setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_invoices_late_fee_minor',           setting_value: 2500,  setting_type: 'crm' },
  { setting_key: 'crm_invoices_late_fee_label',           setting_value: 'Mahngebühr', setting_type: 'crm' },
  { setting_key: 'crm_invoices_skonto_business_days',     setting_value: 5,     setting_type: 'crm' },
  // Numbering
  { setting_key: 'crm_quotes_number_format',              setting_value: 'Q-{YEAR}-{SEQ:04d}',   setting_type: 'crm' },
  { setting_key: 'crm_invoices_number_format',            setting_value: 'R-{YEAR}-{SEQ:04d}',   setting_type: 'crm' },
];

// Email templates seeded inline so the entire CRM data layer lands as
// one migration record in knex_migrations. Same approach as migration
// 090 which seeded the customer_invitation template alongside the
// customer_accounts schema. Bodies are en + de hand-translated; fr/
// nl/pt/ru intentionally absent — they fall through to en until the
// admin or a translator overrides them via the Templates UI (flagged
// in PR description per project translation-flagging convention).
const CRM_EMAIL_TEMPLATES = {
  quote_sent: {
    category: 'quotes', feature_flag: 'quotes',
    variables: ['quote_number', 'customer_name', 'response_url', 'accept_url', 'decline_url',
                'valid_until', 'event_name', 'total_amount'],
    en: {
      subject: 'Your quote {{quote_number}} is ready',
      body_html: `<h2>Quote {{quote_number}}</h2>
<p>Dear {{customer_name}},</p>
<p>Please find the attached quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}}. Total amount: <strong>{{total_amount}}</strong>.</p>
<p>You can accept or decline this quote directly via the buttons below:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{accept_url}}" class="button">Accept quote</a>
  &nbsp;
  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Decline</a>
</p>
<p>Or open the full quote in your browser:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">This quote is valid until {{valid_until}}.</p>{{/if}}`,
      body_text: `Quote {{quote_number}}\n\nDear {{customer_name}},\n\nPlease find the attached quote {{quote_number}}. Total: {{total_amount}}.\n\nRespond: {{response_url}}\nAccept: {{accept_url}}\nDecline: {{decline_url}}\n\n{{#if valid_until}}Valid until {{valid_until}}.{{/if}}`,
    },
    de: {
      subject: 'Ihr Angebot {{quote_number}} ist bereit',
      body_html: `<h2>Angebot {{quote_number}}</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>im Anhang finden Sie das Angebot {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}}. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>
<p>Sie können das Angebot direkt über die Schaltflächen unten annehmen oder ablehnen:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{accept_url}}" class="button">Angebot annehmen</a>
  &nbsp;
  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Ablehnen</a>
</p>
<p>Oder öffnen Sie das vollständige Angebot im Browser:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Dieses Angebot ist gültig bis {{valid_until}}.</p>{{/if}}`,
      body_text: `Angebot {{quote_number}}\n\nSehr geehrte/r {{customer_name}},\n\nim Anhang finden Sie das Angebot {{quote_number}}. Gesamtbetrag: {{total_amount}}.\n\nAnsehen: {{response_url}}\nAnnehmen: {{accept_url}}\nAblehnen: {{decline_url}}\n\n{{#if valid_until}}Gültig bis {{valid_until}}.{{/if}}`,
    },
  },
  quote_accepted_admin: {
    category: 'quotes', feature_flag: 'quotes',
    variables: ['quote_number', 'customer_email', 'event_name', 'total_amount', 'admin_dashboard_url'],
    en: {
      subject: 'Quote {{quote_number}} accepted by {{customer_email}}',
      body_html: `<h2>Quote accepted</h2><p>{{customer_email}} just accepted quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}}. Total: {{total_amount}}.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Open in admin</a></p>`,
      body_text: `Quote {{quote_number}} accepted by {{customer_email}}. Open: {{admin_dashboard_url}}`,
    },
    de: {
      subject: 'Angebot {{quote_number}} von {{customer_email}} angenommen',
      body_html: `<h2>Angebot angenommen</h2><p>{{customer_email}} hat soeben das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für "{{event_name}}"{{/if}} angenommen. Gesamtbetrag: {{total_amount}}.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Im Admin-Bereich öffnen</a></p>`,
      body_text: `Angebot {{quote_number}} von {{customer_email}} angenommen. Öffnen: {{admin_dashboard_url}}`,
    },
  },
  quote_declined_admin: {
    category: 'quotes', feature_flag: 'quotes',
    variables: ['quote_number', 'customer_email', 'event_name', 'admin_dashboard_url'],
    en: {
      subject: 'Quote {{quote_number}} declined by {{customer_email}}',
      body_html: `<p>{{customer_email}} declined quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}}.</p>
<p><a href="{{admin_dashboard_url}}">Open quote in admin</a></p>`,
      body_text: `Quote {{quote_number}} declined by {{customer_email}}. Open: {{admin_dashboard_url}}`,
    },
    de: {
      subject: 'Angebot {{quote_number}} von {{customer_email}} abgelehnt',
      body_html: `<p>{{customer_email}} hat das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für "{{event_name}}"{{/if}} abgelehnt.</p>
<p><a href="{{admin_dashboard_url}}">Angebot im Admin-Bereich öffnen</a></p>`,
      body_text: `Angebot {{quote_number}} von {{customer_email}} abgelehnt. Öffnen: {{admin_dashboard_url}}`,
    },
  },
  invoice_sent: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'event_name', 'total_amount', 'due_date',
                'installment_label', 'installment_index', 'installment_total'],
    en: {
      subject: 'Invoice {{invoice_number}} — {{total_amount}}',
      body_html: `<h2>Invoice {{invoice_number}}</h2><p>Dear {{customer_name}},</p>
<p>Please find the attached invoice {{invoice_number}}{{#if event_name}} for "{{event_name}}"{{/if}}.</p>
<p><strong>Amount:</strong> {{total_amount}}<br><strong>Due:</strong> {{due_date}}{{#if installment_label}}<br><strong>Installment:</strong> {{installment_label}} ({{installment_index}}/{{installment_total}}){{/if}}</p>
<p>The payment details and IBAN are on the attached PDF.</p>`,
      body_text: `Invoice {{invoice_number}}: {{total_amount}}, due {{due_date}}.`,
    },
    de: {
      subject: 'Rechnung {{invoice_number}} — {{total_amount}}',
      body_html: `<h2>Rechnung {{invoice_number}}</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>im Anhang finden Sie die Rechnung {{invoice_number}}{{#if event_name}} für "{{event_name}}"{{/if}}.</p>
<p><strong>Betrag:</strong> {{total_amount}}<br><strong>Fällig:</strong> {{due_date}}{{#if installment_label}}<br><strong>Teilzahlung:</strong> {{installment_label}} ({{installment_index}}/{{installment_total}}){{/if}}</p>
<p>Die Zahlungsdetails und IBAN finden Sie auf dem beigefügten PDF.</p>`,
      body_text: `Rechnung {{invoice_number}}: {{total_amount}}, fällig {{due_date}}.`,
    },
  },
  invoice_reminder_first: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'total_amount', 'due_date', 'days_overdue'],
    en: {
      subject: 'Reminder: invoice {{invoice_number}} is overdue',
      body_html: `<h2>Payment reminder</h2><p>Dear {{customer_name}},</p>
<p>Our records show that invoice <strong>{{invoice_number}}</strong> (originally due {{due_date}}) is now {{days_overdue}} days overdue. The outstanding amount is <strong>{{total_amount}}</strong>.</p>
<p>If you have already paid, please ignore this reminder. Otherwise, please find a fresh copy attached.</p>`,
      body_text: `Invoice {{invoice_number}} is {{days_overdue}} days overdue. Outstanding: {{total_amount}}.`,
    },
    de: {
      subject: 'Zahlungserinnerung: Rechnung {{invoice_number}}',
      body_html: `<h2>Zahlungserinnerung</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>laut unseren Unterlagen ist die Rechnung <strong>{{invoice_number}}</strong> (ursprünglich fällig am {{due_date}}) seit {{days_overdue}} Tagen überfällig. Der offene Betrag beträgt <strong>{{total_amount}}</strong>.</p>
<p>Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie diese Erinnerung als gegenstandslos. Im Anhang finden Sie eine aktuelle Kopie der Rechnung.</p>`,
      body_text: `Rechnung {{invoice_number}} ist seit {{days_overdue}} Tagen überfällig. Offen: {{total_amount}}.`,
    },
  },
  invoice_reminder_second: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'total_amount', 'due_date', 'days_overdue',
                'late_fee_amount', 'new_total_amount'],
    en: {
      subject: 'Second reminder: invoice {{invoice_number}}',
      body_html: `<h2>Second payment reminder</h2><p>Dear {{customer_name}},</p>
<p>Invoice <strong>{{invoice_number}}</strong> is now {{days_overdue}} days overdue. As advised in our payment terms, a late fee of <strong>{{late_fee_amount}}</strong> has been added. The new total is <strong>{{new_total_amount}}</strong>.</p>
<p>Please settle the outstanding amount as soon as possible. A revised invoice is attached.</p>`,
      body_text: `Second reminder for {{invoice_number}}. Late fee {{late_fee_amount}} added. New total: {{new_total_amount}}.`,
    },
    de: {
      subject: 'Zweite Mahnung: Rechnung {{invoice_number}}',
      body_html: `<h2>Zweite Zahlungserinnerung</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>die Rechnung <strong>{{invoice_number}}</strong> ist nun seit {{days_overdue}} Tagen überfällig. Gemäss unseren Zahlungsbedingungen wurde eine Mahngebühr von <strong>{{late_fee_amount}}</strong> hinzugefügt. Der neue Gesamtbetrag beträgt <strong>{{new_total_amount}}</strong>.</p>
<p>Wir bitten Sie, den offenen Betrag umgehend zu begleichen. Eine aktualisierte Rechnung finden Sie im Anhang.</p>`,
      body_text: `Zweite Mahnung für {{invoice_number}}. Mahngebühr {{late_fee_amount}} hinzugefügt. Neuer Gesamtbetrag: {{new_total_amount}}.`,
    },
  },
  invoice_paid_receipt: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'paid_amount', 'paid_at'],
    en: {
      subject: 'Receipt for invoice {{invoice_number}}',
      body_html: `<h2>Payment received</h2><p>Dear {{customer_name}},</p>
<p>We received your payment of <strong>{{paid_amount}}</strong> for invoice {{invoice_number}} on {{paid_at}}. Thank you!</p>`,
      body_text: `Receipt: {{paid_amount}} received for {{invoice_number}} on {{paid_at}}.`,
    },
    de: {
      subject: 'Zahlungsbestätigung für Rechnung {{invoice_number}}',
      body_html: `<h2>Zahlung erhalten</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>vielen Dank für Ihre Zahlung in Höhe von <strong>{{paid_amount}}</strong> für die Rechnung {{invoice_number}} am {{paid_at}}.</p>`,
      body_text: `Zahlungsbestätigung: {{paid_amount}} erhalten für {{invoice_number}} am {{paid_at}}.`,
    },
  },
  invoice_cancelled: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name'],
    en: {
      subject: 'Invoice {{invoice_number}} cancelled',
      body_html: `<p>Dear {{customer_name}},</p><p>Invoice {{invoice_number}} has been cancelled. Please disregard any previous reminders for this invoice.</p>`,
      body_text: `Invoice {{invoice_number}} has been cancelled.`,
    },
    de: {
      subject: 'Rechnung {{invoice_number}} storniert',
      body_html: `<p>Sehr geehrte/r {{customer_name}},</p><p>die Rechnung {{invoice_number}} wurde storniert. Bitte ignorieren Sie eventuelle frühere Erinnerungen zu dieser Rechnung.</p>`,
      body_text: `Rechnung {{invoice_number}} wurde storniert.`,
    },
  },
};

exports.up = async function(knex) {
  // ---- business_profile (singleton) ------------------------------------
  if (!(await knex.schema.hasTable('business_profile'))) {
    await knex.schema.createTable('business_profile', (table) => {
      table.increments('id').primary();
      // Issuer block printed top-right on every PDF. All nullable so the
      // singleton row can be seeded empty and filled in via the Settings UI.
      table.string('company_name', 255);
      table.string('address_line1', 255);
      table.string('address_line2', 255);
      table.string('postal_code', 20);
      table.string('city', 120);
      table.string('state', 120);
      table.string('country_code', 2); // ISO 3166-1 alpha-2
      table.string('phone', 64);
      table.string('mobile', 64);
      table.string('email', 255);
      table.string('website', 255);
      table.string('vat_id', 64);
      table.string('vat_label', 64).defaultTo('MwSt.');
      // Stored as DECIMAL string to match what app_settings does for percent
      // values elsewhere; rendered as-is on PDFs.
      table.decimal('vat_rate_default', 5, 2).defaultTo(0);
      table.string('default_currency', 3).defaultTo('CHF');
      table.string('default_locale', 8).defaultTo('de');
      // 'swiss' | 'epc' | 'none' — drives QR rendering on invoice PDFs.
      table.string('default_qr_format', 16).defaultTo('none');
      table.string('footer_line', 255);
      // Relative path under storage/ — uploads handled by the existing
      // branding upload route in adminBranding.js.
      table.string('logo_path', 512);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });

    // Seed the singleton row so getProfile() always returns something.
    await knex('business_profile').insert({ id: 1 });
  }

  // ---- business_bank_accounts ------------------------------------------
  if (!(await knex.schema.hasTable('business_bank_accounts'))) {
    await knex.schema.createTable('business_bank_accounts', (table) => {
      table.increments('id').primary();
      table.integer('business_profile_id').unsigned().notNullable().defaultTo(1)
        .references('id').inTable('business_profile').onDelete('CASCADE');
      table.string('label', 128); // e.g. "Hauptkonto" / "EUR-Konto"
      table.string('account_holder', 255);
      table.string('iban', 64).notNullable();
      table.string('bic', 16);
      table.string('currency', 3);
      table.boolean('is_default').notNullable().defaultTo(false);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['business_profile_id']);
      table.index(['currency']);
    });
  }

  // ---- payment_term_templates ------------------------------------------
  if (!(await knex.schema.hasTable('payment_term_templates'))) {
    await knex.schema.createTable('payment_term_templates', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.string('description', 255);
      // Net payment window in days (30 / 60 / 90 etc.) used when no
      // explicit due_date is set.
      table.integer('net_days').notNullable().defaultTo(30);
      // Skonto (early-payment discount) — both nullable when not offered.
      table.decimal('skonto_percent', 5, 2);
      table.integer('skonto_within_days');
      // JSON installments array. SQLite stores TEXT; Postgres JSONB. Knex
      // .json() picks the right native type per dialect.
      table.json('installments').notNullable();
      table.boolean('is_system').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['is_active']);
      table.index(['is_system']);
    });

    // Seed the 4 system templates. Idempotent because we just created
    // the table inside this branch — no need to check for duplicates.
    for (const tpl of SYSTEM_PAYMENT_TERM_TEMPLATES) {
      await knex('payment_term_templates').insert({
        name: tpl.name,
        description: tpl.description,
        net_days: tpl.net_days,
        skonto_percent: tpl.skonto_percent,
        skonto_within_days: tpl.skonto_within_days,
        installments: JSON.stringify(tpl.installments),
        is_system: true,
        is_active: true,
        display_order: tpl.display_order,
      });
    }
  }

  // ---- quote_line_item_presets -----------------------------------------
  if (!(await knex.schema.hasTable('quote_line_item_presets'))) {
    await knex.schema.createTable('quote_line_item_presets', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.text('description'); // multi-line allowed
      // Stored in minor units (cents/Rappen) to avoid float drift.
      // bigInteger keeps room for ridiculously expensive line items;
      // SQLite will silently promote to INTEGER which fits 2^53-1.
      table.bigInteger('unit_price_minor').notNullable().defaultTo(0);
      table.string('currency', 3).notNullable().defaultTo('CHF');
      table.decimal('quantity_default', 10, 2).notNullable().defaultTo(1);
      table.integer('display_order').notNullable().defaultTo(0);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['is_active']);
    });
  }

  // ---- quotes ----------------------------------------------------------
  if (!(await knex.schema.hasTable('quotes'))) {
    await knex.schema.createTable('quotes', (table) => {
      table.increments('id').primary();
      table.string('quote_number', 32).unique().notNullable();
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('RESTRICT');

      // draft | sent | accepted | declined | expired | converted
      table.string('status', 16).notNullable().defaultTo('draft');
      table.string('language', 8).defaultTo('de');
      table.string('currency', 3).notNullable().defaultTo('CHF');

      table.date('issue_date').notNullable();
      table.date('valid_until');

      // Event-data snapshot — not a FK because the event might not exist
      // yet (it's created on quote acceptance).
      table.string('event_name', 255);
      table.date('event_date');
      table.string('event_time_start', 8);   // "HH:MM"
      table.string('event_time_end', 8);
      table.decimal('expected_duration_hours', 4, 2);

      // Payment term — keep a snapshot so editing the template later
      // doesn't mutate already-sent quotes.
      table.integer('payment_term_template_id').unsigned()
        .references('id').inTable('payment_term_templates').onDelete('RESTRICT');
      table.json('payment_term_snapshot'); // copied at send time

      // Totals (server-computed authoritative values, never trust client).
      table.bigInteger('net_amount_minor').notNullable().defaultTo(0);
      table.decimal('vat_rate', 5, 2).defaultTo(0);
      table.bigInteger('vat_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('shipping_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('total_amount_minor').notNullable().defaultTo(0);

      table.text('intro_text');
      table.text('outro_text');
      table.text('internal_notes');
      // Extra recipient for the PDF — comma-separated supported, validated
      // at the service layer.
      table.string('cc_pdf_email', 255);

      // Lifecycle timestamps.
      table.timestamp('sent_at');
      table.timestamp('responded_at');        // first accept/decline action
      table.timestamp('response_locked_at');  // responded_at + 15min
      table.timestamp('accepted_at');
      table.timestamp('declined_at');

      // Set when the quote is converted into an event. Nullable, ON DELETE
      // SET NULL so deleting the event doesn't cascade-delete the quote
      // (we want the audit trail).
      table.integer('converted_event_id').unsigned()
        .references('id').inTable('events').onDelete('SET NULL');

      table.string('pdf_path', 512);
      table.integer('business_bank_account_id').unsigned()
        .references('id').inTable('business_bank_accounts').onDelete('SET NULL');
      table.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['customer_account_id']);
      table.index(['status']);
      table.index(['issue_date']);
    });
  }

  // ---- quote_line_items ------------------------------------------------
  if (!(await knex.schema.hasTable('quote_line_items'))) {
    await knex.schema.createTable('quote_line_items', (table) => {
      table.increments('id').primary();
      table.integer('quote_id').unsigned().notNullable()
        .references('id').inTable('quotes').onDelete('CASCADE');
      table.integer('position').notNullable().defaultTo(0); // 1-based display order
      table.decimal('quantity', 10, 2).notNullable().defaultTo(1);
      table.text('description').notNullable(); // multi-line allowed
      table.bigInteger('unit_price_minor').notNullable().defaultTo(0);
      table.decimal('discount_percent', 5, 2).notNullable().defaultTo(0);
      // Computed server-side on save: round((qty * unit) * (1 - discount/100))
      table.bigInteger('line_total_minor').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['quote_id']);
    });
  }

  // ---- quote_action_tokens ---------------------------------------------
  if (!(await knex.schema.hasTable('quote_action_tokens'))) {
    await knex.schema.createTable('quote_action_tokens', (table) => {
      table.increments('id').primary();
      table.integer('quote_id').unsigned().notNullable()
        .references('id').inTable('quotes').onDelete('CASCADE');
      // 64 hex chars = 32 bytes = 256 bits, same entropy as share tokens.
      table.string('token', 64).unique().notNullable();
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      table.string('used_action', 16);   // 'accepted' | 'declined' | null
      table.string('used_ip', 45);
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['quote_id']);
      table.index(['expires_at']);
    });
  }

  // ---- invoices --------------------------------------------------------
  if (!(await knex.schema.hasTable('invoices'))) {
    await knex.schema.createTable('invoices', (table) => {
      table.increments('id').primary();
      table.string('invoice_number', 32).unique().notNullable();
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('RESTRICT');

      // Audit pointer — set when the invoice was created from a quote
      // conversion; nulled if the source quote is deleted.
      table.integer('source_quote_id').unsigned()
        .references('id').inTable('quotes').onDelete('SET NULL');
      table.integer('event_id').unsigned()
        .references('id').inTable('events').onDelete('SET NULL');

      table.string('language', 8).defaultTo('de');
      table.string('currency', 3).notNullable().defaultTo('CHF');

      table.date('issue_date').notNullable();
      table.date('due_date').notNullable();

      // Split-payment series metadata. Solo invoices have index=0, total=1.
      table.integer('installment_index').notNullable().defaultTo(0);
      table.integer('installment_total').notNullable().defaultTo(1);
      table.string('installment_label', 128);
      // From the source payment_term entry: quote_accepted | before_event |
      // after_event | after_delivery | fixed_date.
      table.string('installment_trigger', 32);

      // scheduled | sent | paid | overdue | cancelled
      table.string('status', 16).notNullable().defaultTo('scheduled');
      // When the email + PDF should fire. NULL = send now on create.
      table.timestamp('scheduled_send_at');
      table.timestamp('sent_at');

      table.bigInteger('net_amount_minor').notNullable().defaultTo(0);
      table.decimal('vat_rate', 5, 2).defaultTo(0);
      table.bigInteger('vat_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('shipping_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('total_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('paid_amount_minor').notNullable().defaultTo(0);
      table.timestamp('paid_at');
      table.string('payment_method', 64);
      table.string('payment_reference', 128);

      // 0 = none, 1 = first reminder, 2 = second reminder (with fee).
      table.integer('reminder_level').notNullable().defaultTo(0);
      table.timestamp('last_reminder_sent_at');
      table.bigInteger('late_fee_amount_minor').notNullable().defaultTo(0);

      table.string('cc_pdf_email', 255);
      table.string('pdf_path', 512);
      table.integer('business_bank_account_id').unsigned()
        .references('id').inTable('business_bank_accounts').onDelete('SET NULL');
      // 'swiss' | 'epc' | 'none' — overrides business_profile.default_qr_format
      // when set per-invoice.
      table.string('qr_format', 16);

      table.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['customer_account_id']);
      table.index(['status']);
      table.index(['due_date']);
      table.index(['scheduled_send_at']);
    });
  }

  // ---- invoice_line_items ----------------------------------------------
  if (!(await knex.schema.hasTable('invoice_line_items'))) {
    await knex.schema.createTable('invoice_line_items', (table) => {
      table.increments('id').primary();
      table.integer('invoice_id').unsigned().notNullable()
        .references('id').inTable('invoices').onDelete('CASCADE');
      table.integer('position').notNullable().defaultTo(0);
      table.decimal('quantity', 10, 2).notNullable().defaultTo(1);
      table.text('description').notNullable();
      table.bigInteger('unit_price_minor').notNullable().defaultTo(0);
      table.decimal('discount_percent', 5, 2).notNullable().defaultTo(0);
      table.bigInteger('line_total_minor').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['invoice_id']);
    });
  }

  // ---- invoice_payment_log ---------------------------------------------
  if (!(await knex.schema.hasTable('invoice_payment_log'))) {
    await knex.schema.createTable('invoice_payment_log', (table) => {
      table.increments('id').primary();
      table.integer('invoice_id').unsigned().notNullable()
        .references('id').inTable('invoices').onDelete('CASCADE');
      table.bigInteger('amount_minor').notNullable();
      table.timestamp('paid_at').notNullable();
      table.string('payment_method', 64);
      table.string('reference', 128);
      table.text('notes');
      table.integer('recorded_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['invoice_id']);
    });
  }

  // ---- event_payment_plans ---------------------------------------------
  if (!(await knex.schema.hasTable('event_payment_plans'))) {
    await knex.schema.createTable('event_payment_plans', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      table.integer('quote_id').unsigned()
        .references('id').inTable('quotes').onDelete('SET NULL');
      table.json('payment_term_snapshot').notNullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['event_id']);
      table.index(['quote_id']);
    });
  }

  // ---- customer_accounts.billing_cadence extension ---------------------
  // Per-customer override that shifts scheduled invoice send dates when
  // the customer is on a fixed billing cycle. Values:
  //   'per_event'   default; respect the quote's installment plan
  //   'monthly'     scheduled_send_at snaps to billing_cycle_day of the
  //                 next calendar month
  //   'quarterly'   scheduled_send_at snaps to billing_cycle_day of the
  //                 first month of the next quarter
  // billing_cycle_day defaults to 1; admin can pick any day 1–28 (the
  // service clamps to month length so February doesn't drop bills).
  if (await knex.schema.hasTable('customer_accounts')) {
    if (!(await knex.schema.hasColumn('customer_accounts', 'billing_cadence'))) {
      await knex.schema.alterTable('customer_accounts', (table) => {
        table.string('billing_cadence', 16).notNullable().defaultTo('per_event');
        table.integer('billing_cycle_day').notNullable().defaultTo(1);
      });
    }
  }

  // ---- events.quote_id extension ---------------------------------------
  if (await knex.schema.hasTable('events')) {
    const hasQuoteId = await knex.schema.hasColumn('events', 'quote_id');
    if (!hasQuoteId) {
      await knex.schema.alterTable('events', (table) => {
        table.integer('quote_id').unsigned()
          .references('id').inTable('quotes').onDelete('SET NULL');
        table.index(['quote_id']);
      });
    }
  }

  // ---- RBAC permissions -------------------------------------------------
  const existingPermissions = await knex('permissions').select('name');
  const existingNames = new Set(existingPermissions.map((p) => p.name));
  const toInsert = NEW_PERMISSIONS.filter((p) => !existingNames.has(p.name));
  if (toInsert.length > 0) {
    await knex('permissions').insert(toInsert);
  }

  // Grant the four permissions to super_admin + admin.
  const roles = await knex('roles').select('id', 'name')
    .whereIn('name', ['super_admin', 'admin']);
  const perms = await knex('permissions').select('id', 'name')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name));

  if (roles.length > 0 && perms.length > 0) {
    const existing = await knex('role_permissions').select('role_id', 'permission_id');
    const existingSet = new Set(existing.map((m) => `${m.role_id}-${m.permission_id}`));
    const inserts = [];
    for (const role of roles) {
      for (const perm of perms) {
        const key = `${role.id}-${perm.id}`;
        if (!existingSet.has(key)) {
          inserts.push({ role_id: role.id, permission_id: perm.id });
        }
      }
    }
    if (inserts.length > 0) {
      await knex('role_permissions').insert(inserts);
    }
  }

  // ---- feature flags ----------------------------------------------------
  if (await knex.schema.hasTable('feature_flags')) {
    for (const key of NEW_FEATURE_FLAGS) {
      const existing = await knex('feature_flags').where({ key }).first();
      if (!existing) {
        // Default OFF — admins opt in via Settings → Features.
        await knex('feature_flags').insert({ key, value: false });
      }
    }
  }

  // ---- CRM sub-function settings ---------------------------------------
  // Seed the per-area toggles the admin can flip in the new CRM Settings
  // tab. These are ON by default so the feature works out-of-the-box
  // once an admin enables the `quotes` / `bills` master flags; an admin
  // can then opt out of Skonto, reminders, late fees, QR-bill etc.
  if (await knex.schema.hasTable('app_settings')) {
    for (const row of CRM_SUB_SETTINGS) {
      const existing = await knex('app_settings').where('setting_key', row.setting_key).first();
      if (!existing) {
        await knex('app_settings').insert({
          setting_key: row.setting_key,
          setting_value: JSON.stringify(row.setting_value),
          setting_type: row.setting_type,
        });
      }
    }
  }

  // ---- CRM email templates --------------------------------------------
  // 8 templates seeded inline with the schema so CRM v1 lands as one
  // knex_migrations row. Mirrors the pattern from migration 090, which
  // seeds customer_invitation alongside the customer_accounts schema.
  // Skips templates that already exist (idempotent).
  if (await knex.schema.hasTable('email_templates')) {
    const cols = await knex('email_templates').columnInfo();
    const hasTranslationsTable = await knex.schema.hasTable('email_template_translations');

    for (const [templateKey, def] of Object.entries(CRM_EMAIL_TEMPLATES)) {
      const existing = await knex('email_templates').where({ template_key: templateKey }).first();
      if (existing) {
        // eslint-disable-next-line no-console
        console.log(`  ${templateKey} template already exists, skipping insert`);
        continue;
      }

      const enContent = def.en;
      const masterRow = {
        template_key: templateKey,
        variables: JSON.stringify(def.variables),
      };
      if ('category' in cols)     masterRow.category = def.category;
      if ('subcategory' in cols)  masterRow.subcategory = null;
      if ('feature_flag' in cols) masterRow.feature_flag = def.feature_flag;
      if ('created_at' in cols)   masterRow.created_at = new Date();
      if ('updated_at' in cols)   masterRow.updated_at = new Date();

      for (const colName of Object.keys(cols)) {
        if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
          masterRow[colName] = enContent.subject;
        } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
          masterRow[colName] = enContent.body_html;
        } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
          masterRow[colName] = enContent.body_text;
        }
      }

      const inserted = await knex('email_templates').insert(masterRow).returning('id');
      const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

      if (hasTranslationsTable && templateId) {
        for (const lang of ['en', 'de']) {
          const content = def[lang];
          if (!content) continue;
          await knex('email_template_translations').insert({
            template_id: templateId,
            language: lang,
            subject: content.subject,
            body_html: content.body_html,
            body_text: content.body_text,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
      // eslint-disable-next-line no-console
      console.log(`  ${templateKey} template seeded with 2 translations`);
    }
  }
};

exports.down = async function(knex) {
  // Drop in reverse dependency order. Permissions / role grants are left
  // alone (idempotent on re-run; the customers.* pattern in migration 090
  // does the same).
  if (await knex.schema.hasTable('events')) {
    const hasQuoteId = await knex.schema.hasColumn('events', 'quote_id');
    if (hasQuoteId) {
      await knex.schema.alterTable('events', (table) => {
        table.dropColumn('quote_id');
      });
    }
  }
  if (await knex.schema.hasTable('customer_accounts')) {
    for (const col of ['billing_cadence', 'billing_cycle_day']) {
      if (await knex.schema.hasColumn('customer_accounts', col)) {
        await knex.schema.alterTable('customer_accounts', (table) => {
          table.dropColumn(col);
        });
      }
    }
  }

  await knex.schema.dropTableIfExists('event_payment_plans');
  await knex.schema.dropTableIfExists('invoice_payment_log');
  await knex.schema.dropTableIfExists('invoice_line_items');
  await knex.schema.dropTableIfExists('invoices');
  await knex.schema.dropTableIfExists('quote_action_tokens');
  await knex.schema.dropTableIfExists('quote_line_items');
  await knex.schema.dropTableIfExists('quotes');
  await knex.schema.dropTableIfExists('quote_line_item_presets');
  await knex.schema.dropTableIfExists('payment_term_templates');
  await knex.schema.dropTableIfExists('business_bank_accounts');
  await knex.schema.dropTableIfExists('business_profile');

  // Drop the feature flags we added (idempotent).
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').whereIn('key', NEW_FEATURE_FLAGS).del();
  }

  // Drop the CRM sub-function settings.
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings')
      .whereIn('setting_key', CRM_SUB_SETTINGS.map((s) => s.setting_key))
      .del();
  }

  // Drop seeded email templates (FK cascades clean the translations).
  if (await knex.schema.hasTable('email_templates')) {
    await knex('email_templates')
      .whereIn('template_key', Object.keys(CRM_EMAIL_TEMPLATES))
      .del();
  }

  // Best-effort permission cleanup.
  await knex('permissions').whereIn('name', NEW_PERMISSIONS.map((p) => p.name)).del();
};

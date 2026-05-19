/**
 * Migration: CRM — Contracts (block-composable, in-browser signing).
 *
 * Adds a third document type alongside quotes (pre-sale) and invoices
 * (post-delivery): a free-standing contract that admins compose from
 * a library of reusable text blocks and send to customers for signing
 * — either via an in-browser canvas signature flow or by uploading a
 * wet-signed PDF.
 *
 * Tables created (4):
 *   - contract_blocks                  the reusable text library
 *   - contracts                        one row per contract document
 *   - contract_block_inclusions        per-contract block selection +
 *                                      frozen body snapshot at send time
 *   - contract_action_tokens           hex tokens for the public sign URL
 *
 * Seed data:
 *   - 12 system blocks across 6 sections (basics, scope, privacy,
 *     commercial, nda, closing). Bodies are en + de hand-written and
 *     are EXAMPLES ONLY — admins must have their own lawyer review
 *     and adapt them before sending to customers (per CLAUDE.md and
 *     per the on-screen disclaimer on the Block Library page).
 *   - 2 email templates: contract_sent, contract_signed_admin_notification.
 *   - 1 feature flag: contracts (default off).
 *   - 2 RBAC permissions: contracts.view, contracts.manage, granted to
 *     super_admin + admin roles.
 *   - 1 app setting: crm_contracts_number_format (default 'C-{YEAR}-{SEQ:04d}').
 *
 * Idempotent — every step is `hasTable` / `hasColumn` / `where` guarded.
 */

const SYSTEM_BLOCKS = [
  // ---- BASICS ----
  {
    slug: 'basics_service',
    section: 'basics',
    name: 'Vertragsgegenstand (Foto-/Videoauftrag)',
    description: 'EXAMPLE — have your lawyer review before sending. Beschreibt Art und Umfang der zu erbringenden fotografischen / filmischen Leistungen.',
    display_order: 10,
    body_text_de: `**Vertragsgegenstand**

Der Auftraggeber ({{customer_name}}) beauftragt den Auftragnehmer ({{issuer_company_name}}) mit der Erbringung der nachfolgend beschriebenen fotografischen und/oder filmischen Leistungen im Rahmen der Veranstaltung „{{event_name}}" am {{event_date}}.

Die konkrete Leistungsbeschreibung (Anzahl Stunden, Locations, Lieferumfang) ergibt sich aus dem zugrundeliegenden Angebot bzw. aus der Auftragsbestätigung.`,
    body_text: `**Subject of contract**

The client ({{customer_name}}) commissions the contractor ({{issuer_company_name}}) to provide the photographic and/or filming services described below in connection with the event "{{event_name}}" on {{event_date}}.

The specific scope of work (hours, locations, deliverables) is set out in the underlying quote or in the order confirmation.`,
  },

  // ---- SCOPE ----
  {
    slug: 'image_rights_private',
    section: 'scope',
    name: 'Bildrechte – privater Gebrauch',
    description: 'EXAMPLE — have your lawyer review before sending. Standardklausel für private Endkunden (Hochzeit, Familie, Portrait). Kein kommerzieller Gebrauch.',
    display_order: 10,
    body_text_de: `**Bildrechte – privater Gebrauch**

Der Auftraggeber erhält ein einfaches, zeitlich und örtlich unbeschränktes Nutzungsrecht an den gelieferten Bildern für ausschliesslich private Zwecke (Familienalbum, Druck, Versand an Freunde und Verwandte, Social-Media-Beiträge im persönlichen Kontext).

Eine kommerzielle Nutzung – insbesondere Werbung, Verkauf, Lizenzierung an Dritte sowie redaktionelle Veröffentlichung – ist ausdrücklich nicht eingeschlossen und bedarf einer separaten schriftlichen Vereinbarung.

Das Urheberrecht verbleibt vollständig beim Auftragnehmer.`,
    body_text: `**Image rights — private use**

The client receives a simple, time- and location-unlimited usage right to the delivered images for strictly private purposes (family album, prints, sharing with friends and relatives, social-media posts in a personal context).

Commercial use — in particular advertising, resale, licensing to third parties, and editorial publication — is expressly NOT included and requires a separate written agreement.

Copyright remains entirely with the contractor.`,
  },
  {
    slug: 'image_rights_commercial',
    section: 'scope',
    name: 'Bildrechte – kommerzielle Nutzung',
    description: 'EXAMPLE — have your lawyer review before sending. Erweiterte Klausel für Geschäftskunden, Agenturen, Marken. Lizenzumfang muss im Auftrag konkretisiert werden.',
    display_order: 20,
    body_text_de: `**Bildrechte – kommerzielle Nutzung**

Der Auftraggeber erhält ein einfaches, nicht-ausschliessliches Nutzungsrecht an den gelieferten Bildern für die im Auftrag bezeichneten kommerziellen Zwecke (Werbung, Online-Marketing, Printmedien, Social-Media-Kommunikation des Auftraggebers).

Der räumliche und zeitliche Lizenzumfang sowie zulässige Bearbeitungen sind im Hauptauftrag bzw. im Angebot zu konkretisieren. Eine Übertragung der Nutzungsrechte an Dritte (z. B. Agenturen, Konzerngesellschaften, Vertragspartner) sowie eine Sublizenzierung sind nur nach vorheriger schriftlicher Zustimmung des Auftragnehmers zulässig.

Der Auftragnehmer hat das Recht, ihn als Urheber gemäss § 13 UrhG bzw. den jeweils anwendbaren urheberrechtlichen Vorschriften zu nennen. Verstösse gegen die Nennungspflicht berechtigen den Auftragnehmer zu einem Aufschlag von 100 % auf die ursprüngliche Lizenzgebühr.

Das Urheberrecht verbleibt beim Auftragnehmer.`,
    body_text: `**Image rights — commercial use**

The client receives a simple, non-exclusive usage right to the delivered images for the commercial purposes specified in the order (advertising, online marketing, print media, the client's social-media communication).

The territorial and temporal scope of the licence and permitted edits are to be set out in the main order or in the quote. A transfer of usage rights to third parties (e.g. agencies, group companies, contractual partners) or sublicensing is only permitted with the contractor's prior written consent.

The contractor is entitled to be named as author in accordance with the applicable copyright law (§ 13 German Copyright Act / equivalent). Breaches of the attribution obligation entitle the contractor to a surcharge of 100 % on the original licence fee.

Copyright remains with the contractor.`,
  },

  // ---- PRIVACY ----
  {
    slug: 'model_release_private',
    section: 'privacy',
    name: 'Modelvertrag / Persönlichkeitsrecht – privat',
    description: 'EXAMPLE — have your lawyer review before sending. Einwilligung zur Anfertigung der Bilder für private Aufträge.',
    display_order: 10,
    body_text_de: `**Einwilligung zur Aufnahme**

Der Auftraggeber bestätigt, alle von ihm benannten und auf den Aufnahmen erkennbaren Personen vorab darüber informiert zu haben, dass im Rahmen der Veranstaltung Foto- und/oder Filmaufnahmen entstehen.

Die Aufnahmen werden ausschliesslich zu den im Vertrag vereinbarten privaten Zwecken erstellt. Eine Veröffentlichung durch den Auftragnehmer – etwa im Portfolio oder auf Social Media – findet nur statt, wenn der Auftraggeber dem ausdrücklich (z. B. über die separat angebotene Portfolio-Freigabe) zustimmt.

Bestehende Persönlichkeitsrechte abgebildeter Personen sind vom Auftraggeber zu wahren.`,
    body_text: `**Consent to photography**

The client confirms having informed in advance all persons identified by them and recognisable in the recordings that photographs and/or video will be taken during the event.

The recordings are produced exclusively for the private purposes agreed in the contract. Publication by the contractor — for example in a portfolio or on social media — only takes place if the client expressly consents (e.g. via the separately offered portfolio release).

The client is responsible for safeguarding the personality rights of the persons depicted.`,
  },
  {
    slug: 'model_release_commercial',
    section: 'privacy',
    name: 'Modelvertrag – kommerziell',
    description: 'EXAMPLE — have your lawyer review before sending. Modelvertragsklausel für kommerzielle Shootings; setzt unterschriebene Model-Releases der abgebildeten Personen voraus.',
    display_order: 20,
    body_text_de: `**Persönlichkeitsrechte / Model-Release**

Der Auftraggeber sichert zu, von allen auf den Aufnahmen erkennbaren Personen vor Beginn der Aufnahme eine schriftliche Einwilligungserklärung (Model-Release) einzuholen, die mindestens den im Auftrag definierten Nutzungsumfang abdeckt.

Auf Anforderung des Auftragnehmers übergibt der Auftraggeber Kopien der Releases. Bei minderjährigen Personen ist zusätzlich die Einwilligung beider Erziehungsberechtigter erforderlich.

Der Auftraggeber stellt den Auftragnehmer von allen Ansprüchen Dritter wegen Verletzung von Persönlichkeitsrechten frei, sofern diese aus einer unvollständigen oder fehlerhaften Einwilligung resultieren, die nicht vom Auftragnehmer eingeholt wurde.`,
    body_text: `**Personality rights / model release**

The client warrants that, prior to the start of recording, a written consent (model release) covering at least the scope of use defined in the order has been obtained from every person recognisable in the recordings.

Upon the contractor's request, the client provides copies of the releases. For minors, the consent of both legal guardians is additionally required.

The client indemnifies the contractor against all third-party claims for infringement of personality rights insofar as such claims arise from an incomplete or defective consent that was not obtained by the contractor.`,
  },
  {
    slug: 'model_release_minors',
    section: 'privacy',
    name: 'Aufnahmen von Minderjährigen',
    description: 'EXAMPLE — have your lawyer review before sending. Zusätzliche Klausel, wenn Kinder fotografiert werden. Sollte zusammen mit einem der Model-Release-Blöcke aktiviert werden.',
    display_order: 30,
    body_text_de: `**Aufnahmen von Minderjährigen**

Werden Personen unter 18 Jahren abgebildet, sichert der Auftraggeber zu, vorab die schriftliche Einwilligung sämtlicher Erziehungsberechtigter eingeholt zu haben. Bei getrennt lebenden Erziehungsberechtigten ist die Zustimmung beider Berechtigten erforderlich.

Auf Verlangen der oder des Erziehungsberechtigten sind Aufnahmen einzelner Kinder unverzüglich und ohne Erstattung von der Auslieferung auszunehmen sowie auf Wunsch dauerhaft zu löschen. Bereits ausgelieferte Bilder bleiben hiervon unberührt.`,
    body_text: `**Recordings of minors**

If persons under the age of 18 are depicted, the client warrants having obtained, in advance, the written consent of all legal guardians. Where guardians live separately, the consent of both is required.

At the request of a guardian, recordings of an individual child are to be excluded from delivery without refund and, on request, permanently deleted. Images already delivered are not affected.`,
  },
  {
    slug: 'dsgvo_data_protection',
    section: 'privacy',
    name: 'Datenschutz (DSGVO)',
    description: 'EXAMPLE — have your lawyer review before sending. Hinweis auf Verarbeitung personenbezogener Daten gemäss DSGVO / nDSG.',
    display_order: 40,
    body_text_de: `**Datenschutz**

Der Auftragnehmer verarbeitet personenbezogene Daten des Auftraggebers (Kontaktdaten, Auftragsdaten, gegebenenfalls Bildmaterial) ausschliesslich zur Vertragserfüllung und im Rahmen der gesetzlichen Aufbewahrungspflichten.

Die Verarbeitung erfolgt nach Massgabe der jeweils anwendbaren Datenschutzgesetze (DSGVO, nDSG/CH-DSG). Detaillierte Informationen zu Art, Umfang, Zweck und Speicherdauer sowie zu den Rechten der betroffenen Personen sind der Datenschutzerklärung des Auftragnehmers zu entnehmen.

Bildmaterial, das identifizierbare Personen zeigt, wird ausschliesslich auf gesicherten Systemen verarbeitet und an Dritte nur im Rahmen des im Vertrag definierten Nutzungsumfangs weitergegeben.`,
    body_text: `**Data protection**

The contractor processes the client's personal data (contact details, order data, image material where applicable) exclusively for the purpose of fulfilling the contract and within the scope of statutory retention obligations.

Processing is carried out in accordance with the applicable data-protection laws (GDPR, Swiss FADP). Detailed information on the type, scope, purpose and storage duration as well as on the rights of data subjects can be found in the contractor's privacy notice.

Image material identifying individual persons is processed exclusively on secured systems and shared with third parties only within the scope of use defined in the contract.`,
  },

  // ---- COMMERCIAL ----
  {
    slug: 'payment_terms_reference',
    section: 'commercial',
    name: 'Zahlungsbedingungen (Verweis)',
    description: 'EXAMPLE — have your lawyer review before sending. Verweist auf die im Auftrag / Angebot definierten Zahlungsbedingungen. Die konkreten Zahlen werden über Platzhalter eingefügt.',
    display_order: 10,
    body_text_de: `**Zahlungsbedingungen**

Die Vergütung ergibt sich aus dem zugrundeliegenden Angebot. Sofern dort nicht anders geregelt, ist die Rechnung innerhalb von {{net_days}} Tagen nach Rechnungsdatum ohne Abzug zur Zahlung fällig.

Bei Zahlung innerhalb von {{skonto_within_days}} Tagen nach Rechnungsdatum wird ein Skonto von {{skonto_percent}} % gewährt.

Der Auftraggeber gerät ohne weitere Mahnung in Verzug, wenn er die Rechnung nicht innerhalb der genannten Frist begleicht. Es gelten die gesetzlichen Verzugszinsen.`,
    body_text: `**Payment terms**

The remuneration is set out in the underlying quote. Unless otherwise specified there, the invoice is payable within {{net_days}} days of the invoice date, with no deductions.

For payment within {{skonto_within_days}} days of the invoice date a discount of {{skonto_percent}} % is granted.

The client is in default without further reminder if the invoice is not settled within the stated period. Statutory interest on overdue payments applies.`,
  },
  {
    slug: 'cancellation_tiered',
    section: 'commercial',
    name: 'Stornierungsregelung (gestaffelt)',
    description: 'EXAMPLE — have your lawyer review before sending. Gestaffelte Stornogebühren je nach Vorlaufzeit zum Event. Beträge im Auftrag konkretisierbar.',
    display_order: 20,
    body_text_de: `**Stornierung und Rücktritt**

Bei einer Stornierung durch den Auftraggeber gelten folgende Pauschalen, sofern keine günstigere Vereinbarung erzielt wird:

- bei Stornierung mehr als 60 Tage vor dem Veranstaltungstermin: {{cancellation_30d_percent}} % der vereinbarten Gesamtvergütung
- bei Stornierung 30 bis 60 Tage vor dem Veranstaltungstermin: 50 % der vereinbarten Gesamtvergütung
- bei Stornierung weniger als 30 Tage vor dem Veranstaltungstermin: 75 % der vereinbarten Gesamtvergütung
- bei Stornierung weniger als 7 Tage vor dem Veranstaltungstermin: 100 % der vereinbarten Gesamtvergütung

Bereits geleistete Anzahlungen werden auf die Stornogebühr angerechnet. Dem Auftraggeber bleibt der Nachweis eines geringeren Schadens vorbehalten.

Höhere Gewalt (Krankheit mit ärztlichem Attest, behördliche Anordnungen, Naturkatastrophen) berechtigt beide Parteien zur kostenfreien Verschiebung des Termins.`,
    body_text: `**Cancellation and withdrawal**

If the client cancels, the following flat-rate fees apply unless a more favourable arrangement is reached:

- cancellation more than 60 days before the event: {{cancellation_30d_percent}} % of the agreed total remuneration
- cancellation 30 to 60 days before the event: 50 % of the agreed total remuneration
- cancellation less than 30 days before the event: 75 % of the agreed total remuneration
- cancellation less than 7 days before the event: 100 % of the agreed total remuneration

Down-payments already made are credited against the cancellation fee. The client reserves the right to prove that a lower loss occurred.

Force majeure (illness with medical certificate, government orders, natural disasters) entitles both parties to reschedule the appointment free of charge.`,
  },

  // ---- NDA ----
  {
    slug: 'nda_mutual',
    section: 'nda',
    name: 'Vertraulichkeit (beidseitig)',
    description: 'EXAMPLE — have your lawyer review before sending. Gegenseitige Geheimhaltungsverpflichtung. Geeignet, wenn der Auftrag vertrauliche Inhalte umfasst (Hochzeit prominenter Personen, Corporate-Event, NDA-pflichtige Inhalte).',
    display_order: 10,
    body_text_de: `**Vertraulichkeit**

Beide Parteien verpflichten sich, sämtliche im Zusammenhang mit diesem Vertrag erlangten vertraulichen Informationen der jeweils anderen Partei – darunter Geschäftsgeheimnisse, persönliche Daten, Inhalte des Auftrags sowie die Identität der abgebildeten Personen – streng vertraulich zu behandeln und nicht an Dritte weiterzugeben.

Die Vertraulichkeitsverpflichtung gilt während der Vertragslaufzeit und für die Dauer von drei (3) Jahren nach deren Beendigung. Sie gilt nicht für Informationen, die nachweislich öffentlich bekannt sind, ohne Vertraulichkeitspflicht von Dritten erlangt wurden oder aufgrund gesetzlicher Verpflichtung offengelegt werden müssen.

Verstösse gegen die Vertraulichkeitspflicht können Schadensersatzansprüche der jeweils anderen Partei nach sich ziehen.`,
    body_text: `**Confidentiality**

Both parties undertake to treat all confidential information of the other party obtained in connection with this contract — including trade secrets, personal data, the subject matter of the order, and the identity of the persons depicted — as strictly confidential and not to disclose it to third parties.

The confidentiality obligation applies during the term of the contract and for three (3) years after its termination. It does not apply to information that is demonstrably publicly known, obtained from third parties without a confidentiality obligation, or required to be disclosed by law.

Breaches of the confidentiality obligation may give rise to claims for damages by the respective other party.`,
  },

  // ---- CLOSING ----
  {
    slug: 'closing_jurisdiction_ch',
    section: 'closing',
    name: 'Schlussbestimmungen (Schweizer Recht)',
    description: 'EXAMPLE — have your lawyer review before sending. Gerichtsstand und anwendbares Recht für Schweizer Auftragnehmer.',
    display_order: 10,
    body_text_de: `**Schlussbestimmungen**

Auf diesen Vertrag findet ausschliesslich schweizerisches Recht unter Ausschluss des UN-Kaufrechts Anwendung.

Ausschliesslicher Gerichtsstand für sämtliche Streitigkeiten aus oder im Zusammenhang mit diesem Vertrag ist – soweit gesetzlich zulässig – der Sitz des Auftragnehmers.

Sollten einzelne Bestimmungen dieses Vertrags ganz oder teilweise unwirksam sein oder werden, bleibt die Wirksamkeit der übrigen Bestimmungen davon unberührt. An die Stelle der unwirksamen Bestimmung tritt eine wirksame Regelung, die dem wirtschaftlichen Zweck der unwirksamen am nächsten kommt.

Änderungen und Ergänzungen dieses Vertrags bedürfen der Schriftform. Dies gilt auch für die Aufhebung dieses Schriftformerfordernisses.`,
    body_text: `**Closing provisions**

This contract is governed exclusively by Swiss law, to the exclusion of the UN Convention on Contracts for the International Sale of Goods.

The exclusive place of jurisdiction for all disputes arising out of or in connection with this contract is — to the extent permitted by law — the registered office of the contractor.

Should individual provisions of this contract be or become wholly or partly invalid, the validity of the remaining provisions shall not be affected. The invalid provision shall be replaced by a valid one which comes closest to its economic purpose.

Amendments and supplements to this contract must be made in writing. This also applies to any waiver of this written-form requirement.`,
  },
  {
    slug: 'closing_jurisdiction_de',
    section: 'closing',
    name: 'Schlussbestimmungen (Deutsches Recht)',
    description: 'EXAMPLE — have your lawyer review before sending. Gerichtsstand und anwendbares Recht für deutsche Auftragnehmer.',
    display_order: 20,
    body_text_de: `**Schlussbestimmungen**

Auf diesen Vertrag findet ausschliesslich das Recht der Bundesrepublik Deutschland unter Ausschluss des UN-Kaufrechts Anwendung.

Ausschliesslicher Gerichtsstand für sämtliche Streitigkeiten aus oder im Zusammenhang mit diesem Vertrag ist – soweit gesetzlich zulässig – der Geschäftssitz des Auftragnehmers.

Sollten einzelne Bestimmungen dieses Vertrags ganz oder teilweise unwirksam sein oder werden, bleibt die Wirksamkeit der übrigen Bestimmungen davon unberührt. An die Stelle der unwirksamen Bestimmung tritt eine wirksame Regelung, die dem wirtschaftlichen Zweck der unwirksamen am nächsten kommt.

Änderungen und Ergänzungen dieses Vertrags bedürfen der Schriftform. Dies gilt auch für die Aufhebung dieses Schriftformerfordernisses.`,
    body_text: `**Closing provisions**

This contract is governed exclusively by the law of the Federal Republic of Germany, to the exclusion of the UN Convention on Contracts for the International Sale of Goods.

The exclusive place of jurisdiction for all disputes arising out of or in connection with this contract is — to the extent permitted by law — the place of business of the contractor.

Should individual provisions of this contract be or become wholly or partly invalid, the validity of the remaining provisions shall not be affected. The invalid provision shall be replaced by a valid one which comes closest to its economic purpose.

Amendments and supplements to this contract must be made in writing. This also applies to any waiver of this written-form requirement.`,
  },
];

const NEW_PERMISSIONS = [
  { name: 'contracts.view',   display_name: 'View Contracts',   category: 'contracts', description: 'View contracts and their signing status' },
  { name: 'contracts.manage', display_name: 'Manage Contracts', category: 'contracts', description: 'Create, edit, send and counter-sign contracts and manage the block library' },
];

const NEW_FEATURE_FLAGS = ['contracts'];

const CRM_CONTRACT_SETTINGS = [
  { setting_key: 'crm_contracts_number_format', setting_value: 'C-{YEAR}-{SEQ:04d}', setting_type: 'crm' },
  { setting_key: 'crm_contracts_default_valid_days', setting_value: 30, setting_type: 'crm' },
  // Behaviour toggles surfaced in Settings → CRM-Settings → CRM
  // behaviour → Contracts. Mirror the quote/invoice toggle shape so
  // admins find them where they expect.
  // - pdf_attachment_enabled: when true, sendContract attaches the
  //   rendered PDF to the customer email alongside the signing link.
  //   Admins who prefer a leaner email (link only) set this off.
  // - require_drawn_signature: when true, the public sign page
  //   rejects submissions where the canvas is empty — typed name +
  //   "I accept" alone aren't enough. Default off because canvas
  //   signing on a desktop trackpad is awkward.
  // - allow_pdf_upload: when true, the public sign page offers
  //   "Upload a wet-signed PDF" as an alternative path. Off forces
  //   all customers through the in-browser flow.
  { setting_key: 'crm_contracts_pdf_attachment_enabled', setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_contracts_require_drawn_signature', setting_value: false, setting_type: 'crm' },
  { setting_key: 'crm_contracts_allow_pdf_upload',        setting_value: true,  setting_type: 'crm' },
];

// CRM email templates — definitions live in
// backend/src/services/contractEmailTemplates.js so the runtime
// self-heal helper (ensureContractEmailTemplatesSeeded) reads from the
// same source as this migration. Keeping them as a require here means
// adding a new template means editing one file, not two.
const { CONTRACT_EMAIL_TEMPLATES: CRM_EMAIL_TEMPLATES } = require('../../src/services/contractEmailTemplates');

// Legacy inline definition kept for reference / safety in case the
// services file gets removed. The require() above wins when present.
// eslint-disable-next-line no-unused-vars
const _LEGACY_CRM_EMAIL_TEMPLATES = {
  contract_sent: {
    category: 'contracts', feature_flag: 'contracts',
    variables: ['contract_number', 'customer_name', 'response_url', 'title', 'event_name', 'valid_until'],
    en: {
      subject: 'Contract {{contract_number}} ready for your signature',
      body_html: `<h2>Contract {{contract_number}}</h2>
<p>Dear {{customer_name}},</p>
<p>Please find the contract {{contract_number}}{{#if title}} — "{{title}}"{{/if}}{{#if event_name}} for "{{event_name}}"{{/if}} attached.</p>
<p>You can review and sign the contract directly in your browser via the link below:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{response_url}}" class="button">Review &amp; sign contract</a>
</p>
<p>Or open the full contract:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Please sign by {{valid_until}}.</p>{{/if}}`,
      body_text: `Contract {{contract_number}}\n\nDear {{customer_name}},\n\nPlease review and sign the contract {{contract_number}}.\n\nOpen: {{response_url}}\n\n{{#if valid_until}}Please sign by {{valid_until}}.{{/if}}`,
    },
    de: {
      subject: 'Vertrag {{contract_number}} zur Unterzeichnung bereit',
      body_html: `<h2>Vertrag {{contract_number}}</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>im Anhang finden Sie den Vertrag {{contract_number}}{{#if title}} – „{{title}}"{{/if}}{{#if event_name}} für „{{event_name}}"{{/if}}.</p>
<p>Sie können den Vertrag direkt online prüfen und unterzeichnen:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{response_url}}" class="button">Vertrag prüfen &amp; unterzeichnen</a>
</p>
<p>Oder öffnen Sie den vollständigen Vertrag im Browser:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Bitte unterzeichnen Sie bis {{valid_until}}.</p>{{/if}}`,
      body_text: `Vertrag {{contract_number}}\n\nSehr geehrte/r {{customer_name}},\n\nbitte prüfen und unterzeichnen Sie den Vertrag {{contract_number}}.\n\nÖffnen: {{response_url}}\n\n{{#if valid_until}}Bitte unterzeichnen bis {{valid_until}}.{{/if}}`,
    },
  },
  contract_fully_signed: {
    category: 'contracts', feature_flag: 'contracts',
    variables: ['contract_number', 'customer_name', 'title'],
    en: {
      subject: 'Contract {{contract_number}} fully signed',
      body_html: `<h2>Contract {{contract_number}} — fully signed</h2>
<p>Dear {{customer_name}},</p>
<p>Both parties have now signed contract {{contract_number}}{{#if title}} — "{{title}}"{{/if}}. Please find the fully signed PDF attached for your records.</p>
<p style="font-size: 13px; color: #666;">This is the authoritative signed copy. Keep it alongside the related quote and invoices.</p>`,
      body_text: `Contract {{contract_number}} is now fully signed by both parties. The signed PDF is attached for your records.`,
    },
    de: {
      subject: 'Vertrag {{contract_number}} vollständig unterzeichnet',
      body_html: `<h2>Vertrag {{contract_number}} – vollständig unterzeichnet</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>der Vertrag {{contract_number}}{{#if title}} – „{{title}}"{{/if}} wurde nun von beiden Parteien unterzeichnet. Im Anhang finden Sie das beidseitig unterzeichnete PDF für Ihre Unterlagen.</p>
<p style="font-size: 13px; color: #666;">Dies ist die massgebliche unterzeichnete Fassung. Bewahren Sie sie zusammen mit dem zugehörigen Angebot und den Rechnungen auf.</p>`,
      body_text: `Vertrag {{contract_number}} ist nun beidseitig unterzeichnet. Das unterzeichnete PDF finden Sie im Anhang.`,
    },
  },
  contract_signed_admin_notification: {
    category: 'contracts', feature_flag: 'contracts',
    variables: ['contract_number', 'customer_email', 'signed_customer_name', 'admin_dashboard_url'],
    en: {
      subject: 'Contract {{contract_number}} signed by {{customer_email}}',
      body_html: `<h2>Contract signed</h2><p>{{signed_customer_name}} ({{customer_email}}) has just signed contract <strong>{{contract_number}}</strong>.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Open in admin</a></p>
<p style="font-size: 13px; color: #666;">The signed PDF and signature evidence (typed name, IP, timestamp, signature image if drawn) are available on the contract detail page. To make this fully binding, counter-sign the contract or upload a wet-signed copy.</p>`,
      body_text: `Contract {{contract_number}} signed by {{signed_customer_name}} ({{customer_email}}). Open: {{admin_dashboard_url}}`,
    },
    de: {
      subject: 'Vertrag {{contract_number}} von {{customer_email}} unterzeichnet',
      body_html: `<h2>Vertrag unterzeichnet</h2><p>{{signed_customer_name}} ({{customer_email}}) hat soeben den Vertrag <strong>{{contract_number}}</strong> unterzeichnet.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Im Admin-Bereich öffnen</a></p>
<p style="font-size: 13px; color: #666;">Das unterzeichnete PDF und die Signatur-Belege (Name, IP, Zeitstempel, Signaturbild falls gezeichnet) sind auf der Vertragsdetailseite einsehbar. Für vollständige Verbindlichkeit unterzeichnen Sie den Vertrag gegen oder laden Sie eine handunterschriebene Kopie hoch.</p>`,
      body_text: `Vertrag {{contract_number}} von {{signed_customer_name}} ({{customer_email}}) unterzeichnet. Öffnen: {{admin_dashboard_url}}`,
    },
  },
};

exports.up = async function(knex) {
  // ---- contract_blocks --------------------------------------------------
  if (!(await knex.schema.hasTable('contract_blocks'))) {
    await knex.schema.createTable('contract_blocks', (table) => {
      table.increments('id').primary();
      // Stable slug for system blocks so admins can recognise / search;
      // unique across both system and admin-authored rows.
      table.string('slug', 64).unique().notNullable();
      // 'basics' | 'scope' | 'privacy' | 'commercial' | 'nda' | 'closing'
      table.string('section', 32).notNullable();
      table.string('name', 128).notNullable();
      table.string('description', 255);
      // EN body, supports {{placeholders}}. text in MySQL/Postgres; SQLite
      // promotes to TEXT.
      table.text('body_text').notNullable();
      // DE body. Nullable — admin-authored blocks may be EN-only.
      table.text('body_text_de');
      // is_system rows are seeded by this migration; their bodies remain
      // editable by the admin (lawyer review pass) but they cannot be
      // deleted, only deactivated.
      table.boolean('is_system').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['section', 'display_order']);
      table.index(['is_active']);
      table.index(['is_system']);
    });

    // Seed the 12 system blocks. Idempotent because we just created
    // the table inside this branch.
    for (const block of SYSTEM_BLOCKS) {
      await knex('contract_blocks').insert({
        slug: block.slug,
        section: block.section,
        name: block.name,
        description: block.description,
        body_text: block.body_text,
        body_text_de: block.body_text_de,
        is_system: true,
        is_active: true,
        display_order: block.display_order,
      });
    }
    // eslint-disable-next-line no-console
    console.log(`  ${SYSTEM_BLOCKS.length} system contract blocks seeded`);
  }

  // ---- contracts --------------------------------------------------------
  if (!(await knex.schema.hasTable('contracts'))) {
    await knex.schema.createTable('contracts', (table) => {
      table.increments('id').primary();
      table.string('contract_number', 32).unique().notNullable();
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('RESTRICT');

      table.string('language', 8).defaultTo('de');

      // draft | sent | signed_by_customer | signed_by_admin
      //   | fully_signed | cancelled
      table.string('status', 24).notNullable().defaultTo('draft');

      table.date('issue_date').notNullable();
      // Soft deadline for signing — surfaced in the email + on the public
      // page. Not enforced server-side.
      table.date('valid_until');

      // Admin-typed contract title used for the cover and email subject.
      table.string('title', 255);
      table.text('intro_text');
      table.text('outro_text');

      // Path on disk to the system-generated PDF (no signature yet, or
      // re-rendered with the customer-drawn signature stamped in).
      table.string('pdf_path', 512);
      // Path to a wet-signed PDF uploaded by either party. When set, this
      // is the AUTHORITATIVE signed copy; the system PDF is kept for
      // audit but the signed_pdf is what gets sent + archived.
      table.string('signed_pdf_path', 512);

      table.timestamp('sent_at');
      table.timestamp('signed_by_customer_at');
      table.timestamp('signed_by_admin_at');

      // Customer in-browser signature evidence.
      table.string('signed_customer_name', 255);
      table.string('signed_customer_ip', 45);
      table.string('signed_customer_signature_path', 512); // PNG of canvas drawing

      // Admin counter-signature evidence (same shape).
      table.string('signed_admin_name', 255);
      table.string('signed_admin_ip', 45);
      table.string('signed_admin_signature_path', 512);

      // ---- lineage (conversion lanes between quote → contract → event/invoice)
      // source_quote_id: set when admin converts an accepted quote into
      //   a draft contract. Required for converting the contract back
      //   into event / invoices later (contracts have no line items of
      //   their own, the original quote's items + payment plan are
      //   replayed).
      // converted_event_id: back-pointer set when the contract is
      //   converted into an event. Mirrors quotes.converted_event_id.
      //   ON DELETE SET NULL so deleting the event preserves the
      //   contract's audit trail.
      table.integer('source_quote_id').unsigned()
        .references('id').inTable('quotes').onDelete('SET NULL');
      table.integer('converted_event_id').unsigned()
        .references('id').inTable('events').onDelete('SET NULL');

      table.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['customer_account_id']);
      table.index(['status']);
      table.index(['issue_date']);
      table.index(['source_quote_id']);
    });
  }

  // ---- contract_block_inclusions ---------------------------------------
  if (!(await knex.schema.hasTable('contract_block_inclusions'))) {
    await knex.schema.createTable('contract_block_inclusions', (table) => {
      table.increments('id').primary();
      table.integer('contract_id').unsigned().notNullable()
        .references('id').inTable('contracts').onDelete('CASCADE');
      table.integer('block_id').unsigned().notNullable()
        .references('id').inTable('contract_blocks').onDelete('RESTRICT');

      // Denormalised from contract_blocks.section so renaming a block's
      // section later doesn't reshuffle already-issued contracts.
      table.string('section', 32).notNullable();
      // 1-based order within this section on THIS contract. Drag-and-
      // drop in the editor updates this.
      table.integer('position').notNullable().defaultTo(0);

      // Frozen body snapshots captured at sendContract() time. Future
      // edits to the source block don't mutate already-sent contracts.
      table.text('body_text_snapshot');
      table.text('body_text_de_snapshot');

      // Admin toggle. included=false leaves the row for history but is
      // omitted from the PDF + public view. Soft-delete pattern.
      table.boolean('included').notNullable().defaultTo(true);

      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['contract_id', 'section', 'position']);
      table.index(['block_id']);
    });
  }

  // ---- contract_action_tokens ------------------------------------------
  if (!(await knex.schema.hasTable('contract_action_tokens'))) {
    await knex.schema.createTable('contract_action_tokens', (table) => {
      table.increments('id').primary();
      table.integer('contract_id').unsigned().notNullable()
        .references('id').inTable('contracts').onDelete('CASCADE');
      table.string('token', 64).unique().notNullable();
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      table.string('used_action', 32);   // 'signed_by_customer' | 'uploaded_signed_pdf'
      table.string('used_ip', 45);
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['contract_id']);
      table.index(['expires_at']);
    });
  }

  // ---- lineage back-pointers on existing tables ------------------------
  // Mirrors how migration 102 added events.quote_id when quotes shipped:
  // existing tables get a nullable FK so the conversion flow can record
  // "this quote produced contract X" / "this invoice was generated from
  // contract Y" without restructuring the original schema. Idempotent.
  if (await knex.schema.hasTable('quotes')) {
    if (!(await knex.schema.hasColumn('quotes', 'converted_contract_id'))) {
      await knex.schema.alterTable('quotes', (table) => {
        table.integer('converted_contract_id').unsigned()
          .references('id').inTable('contracts').onDelete('SET NULL');
        table.index(['converted_contract_id']);
      });
    }
  }
  if (await knex.schema.hasTable('invoices')) {
    if (!(await knex.schema.hasColumn('invoices', 'source_contract_id'))) {
      await knex.schema.alterTable('invoices', (table) => {
        table.integer('source_contract_id').unsigned()
          .references('id').inTable('contracts').onDelete('SET NULL');
        table.index(['source_contract_id']);
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

  // ---- feature flag -----------------------------------------------------
  if (await knex.schema.hasTable('feature_flags')) {
    for (const key of NEW_FEATURE_FLAGS) {
      const existing = await knex('feature_flags').where({ key }).first();
      if (!existing) {
        await knex('feature_flags').insert({ key, value: false });
      }
    }
  }

  // ---- CRM contract settings -------------------------------------------
  if (await knex.schema.hasTable('app_settings')) {
    for (const row of CRM_CONTRACT_SETTINGS) {
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

  // ---- email templates --------------------------------------------------
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
  // Drop the lineage back-pointers BEFORE the contracts table itself —
  // otherwise the FK constraint on quotes.converted_contract_id /
  // invoices.source_contract_id blocks the table drop.
  if (await knex.schema.hasTable('quotes')) {
    if (await knex.schema.hasColumn('quotes', 'converted_contract_id')) {
      await knex.schema.alterTable('quotes', (table) => {
        table.dropColumn('converted_contract_id');
      });
    }
  }
  if (await knex.schema.hasTable('invoices')) {
    if (await knex.schema.hasColumn('invoices', 'source_contract_id')) {
      await knex.schema.alterTable('invoices', (table) => {
        table.dropColumn('source_contract_id');
      });
    }
  }

  await knex.schema.dropTableIfExists('contract_action_tokens');
  await knex.schema.dropTableIfExists('contract_block_inclusions');
  await knex.schema.dropTableIfExists('contracts');
  await knex.schema.dropTableIfExists('contract_blocks');

  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').whereIn('key', NEW_FEATURE_FLAGS).del();
  }
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings')
      .whereIn('setting_key', CRM_CONTRACT_SETTINGS.map((s) => s.setting_key))
      .del();
  }
  if (await knex.schema.hasTable('email_templates')) {
    await knex('email_templates')
      .whereIn('template_key', Object.keys(CRM_EMAIL_TEMPLATES))
      .del();
  }
  await knex('permissions').whereIn('name', NEW_PERMISSIONS.map((p) => p.name)).del();
};

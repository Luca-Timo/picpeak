/**
 * Admin → Settings → CRM → Reminder Emails.
 *
 * Two-column page modelled after the contracts BlockLibraryPage:
 *
 *   - Left rail: every active event_type, plus a fixed "Default
 *     (catch-all)" entry at the top. Each row indicates whether a
 *     `event_reminder_<slug_prefix>` template currently exists; the
 *     default row always exists (seeded by migration 143).
 *   - Right panel: language tabs (EN / DE) + Subject + Body Text +
 *     Body HTML fields. Save button persists; missing per-type
 *     templates are created from the default's current content on
 *     first Save.
 *
 * Plus a small header strip with the two global toggles
 * (`crm_event_reminders_enabled`, `crm_event_reminders_days_before`)
 * so the entire pre-event-reminder admin surface lives on one page.
 *
 * Template-key naming convention (matches eventReminderService):
 *   - `event_reminder_default` — catch-all, always present
 *   - `event_reminder_<event_type slug_prefix>` — per-type override
 *
 * Resolver at send time: per-type → default. So an admin who only
 * wants to customise weddings can edit `event_reminder_wedding`;
 * concerts and corporate events continue to use the default until
 * the admin also creates per-type entries for them.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Save, AlertTriangle } from 'lucide-react';
import { Button, Card, Loading, Input } from '../../../components/common';
import { eventTypesService } from '../../../services/eventTypes.service';
import { emailService, type EmailTemplate, type EmailTemplateTranslation } from '../../../services/email.service';
import { settingsService } from '../../../services/settings.service';

const TEMPLATE_KEY_DEFAULT = 'event_reminder_default';
const TEMPLATE_KEY_PREFIX = 'event_reminder_';
const LANGUAGES = ['en', 'de'] as const;
type Lang = (typeof LANGUAGES)[number];

interface SidebarRow {
  key: string;
  label: string;
  emoji: string;
  isDefault: boolean;
  hasTemplate: boolean;
  /** When false (per-type without a row yet), the right panel
   *  pre-fills from the default and "Save" creates the row. */
}

export const ReminderTemplatesPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // ---- Global toggles ---------------------------------------------------
  const { data: settings } = useQuery({
    queryKey: ['reminder-settings'],
    queryFn: () => settingsService.getAllSettings(),
  });
  const [enabled, setEnabled] = useState<boolean>(false);
  const [daysBefore, setDaysBefore] = useState<number>(2);
  useEffect(() => {
    if (!settings) return;
    const e = settings.crm_event_reminders_enabled;
    setEnabled(e === true || e === 'true' || e === 1 || e === '1');
    const d = Number(settings.crm_event_reminders_days_before);
    setDaysBefore(Number.isFinite(d) ? d : 2);
  }, [settings]);
  const saveSettingsMutation = useMutation({
    mutationFn: () => settingsService.updateSettings({
      crm_event_reminders_enabled: enabled,
      crm_event_reminders_days_before: daysBefore,
    }),
    onSuccess: () => {
      toast.success(t('reminderTemplates.settingsSaved', 'Reminder settings saved.'));
      queryClient.invalidateQueries({ queryKey: ['reminder-settings'] });
    },
    onError: () => toast.error(t('reminderTemplates.settingsSaveError', 'Could not save reminder settings.')),
  });

  // ---- Event types catalog ---------------------------------------------
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['event-types-active'],
    queryFn: () => eventTypesService.getActiveEventTypes(),
  });

  // ---- All templates (for the "has template?" indicator) ---------------
  const { data: allTemplates = [] } = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => emailService.getTemplates(),
  });
  const reminderTemplateKeys = useMemo(
    () => new Set(allTemplates
      .filter((t) => t.template_key.startsWith(TEMPLATE_KEY_PREFIX))
      .map((t) => t.template_key)),
    [allTemplates],
  );

  // ---- Sidebar rows ------------------------------------------------------
  const sidebarRows: SidebarRow[] = useMemo(() => {
    const rows: SidebarRow[] = [{
      key: TEMPLATE_KEY_DEFAULT,
      label: t('reminderTemplates.defaultLabel', 'Default (catch-all)'),
      emoji: '✉️',
      isDefault: true,
      hasTemplate: true,
    }];
    for (const et of eventTypes) {
      const key = `${TEMPLATE_KEY_PREFIX}${et.slug_prefix}`;
      rows.push({
        key,
        label: et.name,
        emoji: et.emoji || '📅',
        isDefault: false,
        hasTemplate: reminderTemplateKeys.has(key),
      });
    }
    return rows;
  }, [eventTypes, reminderTemplateKeys, t]);

  // ---- Selection + per-template fetch ----------------------------------
  const [selectedKey, setSelectedKey] = useState<string>(TEMPLATE_KEY_DEFAULT);
  const [editingLang, setEditingLang] = useState<Lang>('en');

  // The default template's content. We always load it, because per-type
  // templates that don't exist yet pre-fill their right-panel fields
  // from the default so the admin can see what the customer would
  // currently receive (and decide whether to override).
  const { data: defaultTemplate } = useQuery({
    queryKey: ['email-template', TEMPLATE_KEY_DEFAULT],
    queryFn: () => emailService.getTemplate(TEMPLATE_KEY_DEFAULT),
  });

  // Selected template — null when admin picked a per-type that doesn't
  // exist yet (handled by the form prefill below).
  const { data: selectedTemplate, isLoading: selectedLoading } = useQuery({
    queryKey: ['email-template', selectedKey],
    queryFn: () => emailService.getTemplate(selectedKey),
    enabled: reminderTemplateKeys.has(selectedKey) || selectedKey === TEMPLATE_KEY_DEFAULT,
  });

  // ---- Form state ------------------------------------------------------
  // Two translations buffered locally — admin can flip between EN/DE
  // without losing edits. Reset whenever the selection changes.
  const emptyTranslation: EmailTemplateTranslation = { subject: '', body_html: '', body_text: '' };
  const [translations, setTranslations] = useState<Record<Lang, EmailTemplateTranslation>>({
    en: emptyTranslation, de: emptyTranslation,
  });

  useEffect(() => {
    // Selection changed — repopulate form from the resolved source:
    //   1. existing template's translations, if it exists
    //   2. default template's translations (prefill for new per-type)
    //   3. blank
    const source = selectedTemplate ?? (
      !reminderTemplateKeys.has(selectedKey) && defaultTemplate ? defaultTemplate : null
    );
    const next: Record<Lang, EmailTemplateTranslation> = { en: emptyTranslation, de: emptyTranslation };
    for (const lang of LANGUAGES) {
      const tr = source?.translations?.[lang];
      if (tr) next[lang] = { subject: tr.subject || '', body_html: tr.body_html || '', body_text: tr.body_text || '' };
    }
    setTranslations(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, selectedTemplate, defaultTemplate]);

  // ---- Save -------------------------------------------------------------
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        translations: {
          en: translations.en,
          de: translations.de,
        },
      };
      if (reminderTemplateKeys.has(selectedKey)) {
        await emailService.updateTemplate(selectedKey, payload);
      } else {
        // First save of a per-type template — POST to create.
        await emailService.createTemplate({
          template_key: selectedKey,
          translations: payload.translations,
          category: 'crm',
          subcategory: 'event_reminder',
          feature_flag: 'crm_event_reminders_enabled',
          variables: ['customer_name', 'event_name', 'event_date', 'event_type', 'days_before', 'business_name'],
        });
      }
    },
    onSuccess: () => {
      toast.success(t('reminderTemplates.saved', 'Template saved.'));
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
      queryClient.invalidateQueries({ queryKey: ['email-template', selectedKey] });
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error || t('reminderTemplates.saveError', 'Could not save template.'));
    },
  });

  // ---- Render -----------------------------------------------------------
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/admin/settings/crm" className="p-2 -ml-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <h1 className="text-2xl font-bold">
          {t('reminderTemplates.title', 'Pre-event reminder emails')}
        </h1>
      </div>

      {/* Global toggles strip */}
      <Card className="mb-4">
        <h3 className="font-semibold text-sm mb-2">
          {t('reminderTemplates.globalSection', 'Global behaviour')}
        </h3>
        <p className="text-xs text-muted-theme mb-3">
          {t('reminderTemplates.globalHelp',
            'Off by default — turn on to start sending pre-event reminders. The offset below is the default; each event can override on its detail page.')}
        </p>
        <div className="flex items-center gap-6 flex-wrap">
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t('reminderTemplates.enableLabel', 'Send pre-event reminder emails')}
          </label>
          <div className="flex items-center gap-2">
            <label htmlFor="reminder-days-before" className="text-sm">
              {t('reminderTemplates.daysBeforeLabel', 'Days before the event')}
            </label>
            <Input
              id="reminder-days-before"
              type="number"
              min={0}
              max={365}
              value={daysBefore}
              onChange={(e) => setDaysBefore(Number(e.target.value))}
              className="w-24"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => saveSettingsMutation.mutate()}
            isLoading={saveSettingsMutation.isPending}
            disabled={saveSettingsMutation.isPending}
            leftIcon={<Save className="w-4 h-4" />}
          >
            {t('reminderTemplates.saveSettings', 'Save global settings')}
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {/* Sidebar */}
        <Card padding="md">
          <h3 className="font-semibold text-sm mb-2">
            {t('reminderTemplates.templatesSection', 'Templates')}
          </h3>
          <p className="text-xs text-muted-theme mb-3">
            {t('reminderTemplates.templatesHelp',
              'One template per event type, plus a catch-all default. Per-type templates inherit fields from the default until you save your first edit.')}
          </p>
          <ul className="space-y-1">
            {sidebarRows.map((row) => {
              const isSelected = row.key === selectedKey;
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(row.key)}
                    className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                      isSelected
                        ? 'bg-accent-dark text-white'
                        : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                    }`}
                  >
                    <span className="text-base">{row.emoji}</span>
                    <span className="flex-1 truncate">{row.label}</span>
                    {!row.hasTemplate && !row.isDefault && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                        {t('reminderTemplates.usesDefault', 'Default')}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* Editor */}
        <Card padding="md">
          {selectedLoading ? <Loading /> : (
            <>
              <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                <div className="flex gap-1">
                  {LANGUAGES.map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => setEditingLang(lang)}
                      className={`px-3 py-1.5 rounded text-sm font-medium ${
                        editingLang === lang
                          ? 'bg-accent-dark text-white'
                          : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700'
                      }`}
                    >
                      {lang.toUpperCase()}
                    </button>
                  ))}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  isLoading={saveMutation.isPending}
                  disabled={saveMutation.isPending}
                  leftIcon={<Save className="w-4 h-4" />}
                >
                  {t('reminderTemplates.saveTemplate', 'Save template')}
                </Button>
              </div>

              {!reminderTemplateKeys.has(selectedKey) && !sidebarRows.find((r) => r.key === selectedKey)?.isDefault && (
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 mb-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
                  <p className="text-sm text-amber-800 dark:text-amber-200">
                    {t('reminderTemplates.willCreateOnSave',
                      'This event type uses the default template. The fields below are pre-filled from the default; saving will create a dedicated template for this event type.')}
                  </p>
                </div>
              )}

              <p className="text-xs text-muted-theme mb-3">
                {t('reminderTemplates.variablesHint',
                  'Available variables: {{customer_name}}, {{event_name}}, {{event_date}}, {{event_type}}, {{days_before}}, {{business_name}}')}
              </p>

              <div className="space-y-3">
                <Input
                  label={t('reminderTemplates.subjectLabel', 'Subject') as string}
                  value={translations[editingLang].subject}
                  onChange={(e) => setTranslations({
                    ...translations,
                    [editingLang]: { ...translations[editingLang], subject: e.target.value },
                  })}
                />
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t('reminderTemplates.bodyTextLabel', 'Body (plain text)')}
                  </label>
                  <textarea
                    rows={10}
                    className="input w-full font-mono text-sm"
                    value={translations[editingLang].body_text}
                    onChange={(e) => setTranslations({
                      ...translations,
                      [editingLang]: { ...translations[editingLang], body_text: e.target.value },
                    })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t('reminderTemplates.bodyHtmlLabel', 'Body (HTML)')}
                  </label>
                  <textarea
                    rows={12}
                    className="input w-full font-mono text-sm"
                    value={translations[editingLang].body_html}
                    onChange={(e) => setTranslations({
                      ...translations,
                      [editingLang]: { ...translations[editingLang], body_html: e.target.value },
                    })}
                  />
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
};

export default ReminderTemplatesPage;

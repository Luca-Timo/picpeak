/**
 * The gallery's Settings tab: every setting of the gallery in sections, one
 * draft, one Save bar (SettingsSaveBar). Replaces the old view/edit toggle,
 * where some cards saved behind Edit and others saved themselves.
 *
 * Sections the admin may not change render read-only (a disabled fieldset);
 * the backend enforces the same permissions on every endpoint.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Trash2 } from 'lucide-react';
import type { Event } from '../../../../types';
import { Button } from '../../../../components/common';
import { SettingsSaveBar } from '../../../../components/admin/SettingsSaveBar';
import { FaceRecognitionCard } from '../../../../components/admin/FaceRecognitionCard';
import { useConfirm } from '../../../../components/common/ConfirmDialog';
import { useFeatureFlags } from '../../../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../../../contexts/PermissionsContext';
import { useLocalizedDate } from '../../../../hooks/useLocalizedDate';
import type { AdminPhoto } from '../../../../services/photos.service';
import type { EventFields, SettingsSectionKey } from './draft';
import type { EventSettingsDraftApi } from './useEventSettingsDraft';
import { AccessSection, GeneralSection, GuestsSection, ReminderSection, SectionCard, SourceSection } from './sections';
import { DownloadsSection } from './DownloadsSection';
import { AppearanceSection } from './AppearanceSection';
import { SlideshowSection } from './SlideshowSection';
import { safeParseDate } from '../utils';

export interface EventSettingsTabProps {
  event: Event;
  settings: EventSettingsDraftApi;
  section: SettingsSectionKey;
  setSection: (section: SettingsSectionKey) => void;
  categories: Array<{ id: number; name: string }>;
  photos: AdminPhoto[];
  phoneFieldEnabled: boolean;
  onArchive: () => void;
  isArchiving: boolean;
  onDelete: () => void;
  isDeleting: boolean;
  refetchEvent: () => void;
}

export const EventSettingsTab: React.FC<EventSettingsTabProps> = ({
  event, settings, section, setSection, categories, photos, phoneFieldEnabled,
  onArchive, isArchiving, onDelete, isDeleting, refetchEvent,
}) => {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  const { hasPermission } = usePermissions();
  const { format } = useLocalizedDate();
  const confirm = useConfirm();
  const { draft, setDraft, setEvent, dirty, isDirty, isSaving, save, discard, downloadsData } = settings;

  const archived = Boolean(event.is_archived);
  const canEdit = hasPermission('events.edit') && !archived;

  const sections: Array<{ key: SettingsSectionKey; label: string; show: boolean }> = [
    { key: 'general', label: t('events.settingsTab.general', 'General'), show: true },
    { key: 'access', label: t('events.settingsTab.access', 'Access'), show: true },
    { key: 'downloads', label: t('events.settingsTab.downloads', 'Downloads'), show: true },
    { key: 'guests', label: t('events.settingsTab.guests', 'Guest interaction'), show: true },
    { key: 'appearance', label: t('events.settingsTab.appearance', 'Appearance'), show: true },
    { key: 'source', label: t('events.settingsTab.source', 'Photo source'), show: true },
    { key: 'reminder', label: t('eventReminderOverride.title', 'Pre-event reminder'), show: !!flags.reminderEmails },
    { key: 'slideshow', label: t('slideshow.adminTitle', 'Live Slideshow'), show: !!flags.slideshow },
    { key: 'faces', label: t('events.settingsTab.faces', 'Faces'), show: !!flags.faces },
    { key: 'danger', label: t('events.settingsTab.danger', 'Danger zone'), show: !archived && (hasPermission('events.archive') || hasPermission('events.delete')) },
  ];
  const visible = sections.filter((s) => s.show);
  const active = visible.some((s) => s.key === section) ? section : 'general';

  const set = (patch: Partial<EventFields>) => setEvent((prev) => ({ ...prev, ...patch }));

  const onSave = async () => {
    const { invalidSection } = await save();
    if (invalidSection) setSection(invalidSection);
  };

  // The date the reminder goes out, when this gallery sets its own offset.
  const reminderDate = (() => {
    const eventDate = safeParseDate(event.event_date);
    const offset = draft.event.event_reminder_offset_days.trim();
    if (!eventDate || offset === '' || !Number.isFinite(Number(offset))) return null;
    const d = new Date(eventDate);
    d.setDate(d.getDate() - Math.floor(Number(offset)));
    return format(d, 'PP');
  })();

  const body = (() => {
    switch (active) {
      case 'general':
        return <GeneralSection f={draft.event} set={set} phoneFieldEnabled={phoneFieldEnabled} />;
      case 'access':
        return <AccessSection f={draft.event} set={set} />;
      case 'downloads':
        return (
          <DownloadsSection
            f={draft.event}
            set={set}
            downloads={draft.downloads}
            setDownloads={(downloads) => setDraft((d) => ({ ...d, downloads }))}
            downloadsData={downloadsData}
          />
        );
      case 'guests':
        return (
          <GuestsSection
            f={draft.event}
            set={set}
            categories={categories}
            feedback={draft.feedback}
            setFeedback={(feedback) => setDraft((d) => ({ ...d, feedback }))}
          />
        );
      case 'appearance':
        return <AppearanceSection f={draft.event} set={set} event={event} photos={photos} readOnly={!canEdit} />;
      case 'source':
        return <SourceSection f={draft.event} set={set} event={event} />;
      case 'reminder':
        return (
          <ReminderSection
            f={draft.event}
            set={set}
            reminderDate={reminderDate}
            recipient={event.customer_email || null}
          />
        );
      case 'slideshow':
        return (
          <SlideshowSection
            event={event}
            style={draft.slideshow}
            setStyle={(slideshow) => setDraft((d) => ({ ...d, slideshow }))}
            canAct={canEdit}
            onLinkChanged={refetchEvent}
          />
        );
      case 'faces':
        // Face recognition is a set of jobs (detect, rescan, recluster,
        // delete) rather than settings, so it acts immediately.
        return <FaceRecognitionCard eventId={event.id} isArchived={archived} />;
      case 'danger':
        return (
          <SectionCard title={t('events.settingsTab.danger', 'Danger zone')}>
            {hasPermission('events.archive') && (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-heading">{t('events.archiveEvent')}</p>
                  <p className="text-xs text-muted">{t('events.archivingInfo')}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Archive className="w-4 h-4" />}
                  isLoading={isArchiving}
                  onClick={async () => {
                    if (await confirm({ message: t('events.archiveConfirm'), variant: 'danger' })) onArchive();
                  }}
                >
                  {t('events.archiveEvent')}
                </Button>
              </div>
            )}
            {hasPermission('events.delete') && (
              <div className="flex items-start justify-between gap-4 pt-4 border-t border-line">
                <div>
                  <p className="text-sm font-medium text-heading">{t('events.settingsTab.deleteTitle', 'Delete gallery')}</p>
                  <p className="text-xs text-muted">{t('events.settingsTab.deleteHelp', 'Removes the gallery and its photos for good. This cannot be undone.')}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 dark:text-red-400 border-red-300 dark:border-red-800"
                  leftIcon={<Trash2 className="w-4 h-4" />}
                  isLoading={isDeleting}
                  onClick={async () => {
                    const ok = await confirm({
                      title: t('events.settingsTab.deleteTitle', 'Delete gallery'),
                      message: t('events.settingsTab.deleteConfirm', 'Delete "{{name}}" and all its photos? This cannot be undone.', { name: event.event_name }),
                      variant: 'danger',
                    });
                    if (ok) onDelete();
                  }}
                >
                  {t('common.delete', 'Delete')}
                </Button>
              </div>
            )}
          </SectionCard>
        );
      default:
        return null;
    }
  })();

  // Faces and the danger zone act immediately; everything else is a draft.
  const readOnlyHint = !canEdit && active !== 'faces' && active !== 'danger';

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-6 lg:gap-8">
        <nav aria-label={t('events.settingsTab.sections', 'Settings sections')} className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible lg:sticky lg:top-4 self-start">
          {visible.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              aria-current={s.key === active ? 'page' : undefined}
              className={`flex items-center justify-between gap-2 whitespace-nowrap h-9 px-3 rounded-lg text-sm text-left transition-colors ${
                s.key === active
                  ? 'bg-accent-dark/10 text-heading font-semibold'
                  : s.key === 'danger'
                    ? 'text-red-600 dark:text-red-400 hover:bg-hover'
                    : 'text-body hover:bg-hover'
              }`}
            >
              <span>{s.label}</span>
              {dirty.has(s.key) && (
                <span className="w-2 h-2 rounded-full bg-amber-500" aria-label={t('settings.saveBar.unsaved', 'You have unsaved changes')} />
              )}
            </button>
          ))}
        </nav>

        <div className="min-w-0 max-w-3xl space-y-4">
          {readOnlyHint && (
            <p className="text-sm rounded-lg border border-line bg-inset text-body px-4 py-3">
              {archived
                ? t('events.settingsTab.readOnlyArchived', 'This gallery is archived. Its settings can no longer be changed.')
                : t('events.settingsTab.readOnly', 'You can see these settings but not change them.')}
            </p>
          )}
          <fieldset disabled={readOnlyHint} className="min-w-0 space-y-4">
            {body}
          </fieldset>
        </div>
      </div>

      {/* Nothing to save for a role that may not change settings. */}
      {canEdit && (
      <SettingsSaveBar
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={onSave}
        onDiscard={discard}
        canSave={canEdit}
        extra={isDirty ? (
          <span className="text-xs text-soft mr-2">
            {visible.filter((s) => dirty.has(s.key)).map((s) => s.label).join(', ')}
          </span>
        ) : undefined}
      />
      )}
    </div>
  );
};

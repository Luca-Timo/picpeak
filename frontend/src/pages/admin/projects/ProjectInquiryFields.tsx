/**
 * The fields of a project's inquiry, always editable: "Neue Anfrage" shows
 * them in two sections (Anlass, Rahmen), the project Overview in one card.
 * They only change the draft; saving is the page's job (UX.md › Saving).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { Input, LocalizedDateInput } from '../../../components/common';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { eventTypesService } from '../../../services/eventTypes.service';
import { INQUIRY_SOURCES, PROJECT_FLOWS, type ProjectFlow } from '../../../services/projects.service';
import { radioGroupKeyDown } from '../../../utils/ariaKeyboard';
import { MAX_GUESTS, dateRangeError, guestCountError, type ProjectDraft, type ProjectDraftKey } from './projectDraft';

const CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'];

interface FieldProps {
  draft: ProjectDraft;
  onChange: (patch: Partial<ProjectDraft>) => void;
  /** Fields that differ from the saved project, marked as not saved yet. */
  dirty?: ProjectDraftKey[];
  disabled?: boolean;
  /** `card`: the Overview's 380px column, one field per row (dates side by
   *  side); `form`: the inquiry page, short fields paired from md. */
  layout?: 'form' | 'card';
}

const pairClass = (layout: 'form' | 'card') => (layout === 'card' ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 md:grid-cols-2 gap-4');
const datesClass = (layout: 'form' | 'card') => (layout === 'card' ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 md:grid-cols-2 gap-4');

const dirtyClass = (on: boolean) => (on ? 'border-warning ring-2 ring-warning-soft' : '');

const FLOW_ORDER: ProjectFlow[] = ['full', 'no_contract', 'no_quote'];

/** Which stages the job has: one of a few flows, as tiles (UX.md › Forms). */
export const FlowField: React.FC<FieldProps> = ({ draft, onChange, dirty = [], disabled, layout = 'form' }) => {
  const { t } = useTranslation();
  const sequence = (flow: ProjectFlow) => ['quote', 'contract', 'gallery', 'invoice']
    .filter((key) => !PROJECT_FLOWS[flow].includes(key as never))
    .map((key) => t(`projects.stage.${key}`))
    .join(' → ');
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span id="project-flow-label" className="block text-sm font-medium text-body">{t('projects.flow.label', 'Workflow')}</span>
        {dirty.includes('flow') && <span className="w-2 h-2 rounded-full bg-warning" aria-hidden />}
      </div>
      <div
        // The card sits in the 380px side column from xl up (ProjectCockpitPage)
        // and spans the page below it, where the tiles fit in one row.
        className={layout === 'card' ? 'grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-1 gap-2' : 'grid grid-cols-1 md:grid-cols-3 gap-3'}
        role="radiogroup"
        aria-labelledby="project-flow-label"
        onKeyDown={radioGroupKeyDown}
      >
        {FLOW_ORDER.map((flow) => {
          const on = draft.flow === flow;
          return (
            <button
              key={flow}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange({ flow })}
              className={`flex flex-col items-start gap-0.5 text-left px-3 py-2.5 rounded-lg border-2 transition-all ${on ? 'tile-selected' : 'border-line hover:border-line-strong'}`}
            >
              <span className="text-sm font-semibold text-heading">{t(`projects.flow.${flow}`)}</span>
              <span className="text-xs text-soft">{sequence(flow)}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted">{t('projects.flow.help', 'Stages the workflow leaves out show as skipped. One stage can also be skipped on the project page.')}</p>
    </div>
  );
};

/** Anlass: occasion, guests, dates, location. */
export const OccasionFields: React.FC<FieldProps> = ({ draft, onChange, dirty = [], disabled, layout = 'form' }) => {
  const { t, i18n } = useTranslation();
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['event-types-active'],
    queryFn: () => eventTypesService.getActiveEventTypes(),
  });
  const isDirty = (k: ProjectDraftKey) => dirty.includes(k);

  return (
    <div className="space-y-4">
      <div className={pairClass(layout)}>
        <div className="min-w-0">
          <label htmlFor="project-event-type" className="block text-sm font-medium text-body mb-1">
            {t('projects.field.eventType', 'Occasion')}
          </label>
          <select
            id="project-event-type"
            value={draft.eventType}
            disabled={disabled}
            onChange={(e) => onChange({ eventType: e.target.value })}
            className={`input ${dirtyClass(isDirty('eventType'))}`}
          >
            <option value="">{t('projects.field.eventTypeNone', '— Not set —')}</option>
            {eventTypes.map((et) => (
              <option key={et.id} value={et.slug_prefix}>{et.emoji ? `${et.emoji} ` : ''}{et.name}</option>
            ))}
          </select>
        </div>
        <Input
          label={t('projects.field.guestCount', 'Guests') as string}
          inputMode="numeric"
          value={draft.guestCount}
          disabled={disabled}
          onChange={(e) => onChange({ guestCount: e.target.value.replace(/[^0-9]/g, '') })}
          className={dirtyClass(isDirty('guestCount'))}
          error={guestCountError(draft) ? (t('projects.field.tooManyGuests', 'At most {{max}} guests.', { max: MAX_GUESTS.toLocaleString(i18n.language) }) as string) : undefined}
        />
      </div>
      <div className={datesClass(layout)}>
        <LocalizedDateInput
          label={t('projects.field.eventDate', 'Date from') as string}
          value={draft.eventDate}
          disabled={disabled}
          onChange={(iso) => onChange({ eventDate: iso })}
        />
        <LocalizedDateInput
          label={t('projects.field.eventEndDate', 'to') as string}
          value={draft.eventEndDate}
          min={draft.eventDate || undefined}
          disabled={disabled}
          onChange={(iso) => onChange({ eventEndDate: iso })}
          error={dateRangeError(draft) ? (t('projects.field.endBeforeStart', 'The end date is before the start date.') as string) : undefined}
          helperText={t('projects.field.eventEndDateHelp', 'Only for events over several days.') as string}
        />
      </div>
      <Input
        label={t('projects.field.location', 'Location') as string}
        leftIcon={<MapPin className="w-4 h-4" />}
        value={draft.location}
        maxLength={255}
        disabled={disabled}
        onChange={(e) => onChange({ location: e.target.value })}
        className={dirtyClass(isDirty('location'))}
      />
    </div>
  );
};

/** Rahmen: budget, where the inquiry came from, notes. */
export const FrameFields: React.FC<FieldProps & { defaultCurrency?: string }> = ({
  draft, onChange, dirty = [], disabled, defaultCurrency, layout = 'form',
}) => {
  const { t } = useTranslation();
  const isDirty = (k: ProjectDraftKey) => dirty.includes(k);
  // The business profile's currency when known; otherwise nothing is guessed.
  const currency = draft.currency || defaultCurrency || '';

  return (
    <div className="space-y-4">
      <div className={pairClass(layout)}>
        <div className="min-w-0">
          <label htmlFor="project-budget" className="block text-sm font-medium text-body mb-1">
            {t('projects.field.budget', 'Budget')}
          </label>
          <div className="flex gap-2">
            <DecimalInput
              id="project-budget"
              value={draft.budget}
              disabled={disabled}
              onChange={(budget) => onChange({ budget })}
              className={`input min-w-0 flex-1 ${dirtyClass(isDirty('budget'))}`}
            />
            <select
              aria-label={t('projects.field.currency', 'Currency') as string}
              value={currency}
              disabled={disabled}
              onChange={(e) => onChange({ currency: e.target.value })}
              className={`input w-24 ${dirtyClass(isDirty('currency'))}`}
            >
              {!currency && <option value="">—</option>}
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <p className="mt-1 text-xs text-muted">{t('projects.field.budgetHelp', 'Comma or point, both work.')}</p>
        </div>
        <div className="min-w-0">
          <label htmlFor="project-source" className="block text-sm font-medium text-body mb-1">
            {t('projects.field.source', 'Where did the inquiry come from?')}
          </label>
          <select
            id="project-source"
            value={draft.source}
            disabled={disabled}
            onChange={(e) => onChange({ source: e.target.value })}
            className={`input ${dirtyClass(isDirty('source'))}`}
          >
            <option value="">{t('projects.field.sourceNone', '— Not set —')}</option>
            {INQUIRY_SOURCES.map((s) => (
              <option key={s} value={s}>{t(`projects.source.${s}`)}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="project-notes" className="block text-sm font-medium text-body mb-1">
          {t('projects.field.notes', 'Notes')}
        </label>
        <textarea
          id="project-notes"
          value={draft.notes}
          maxLength={10000}
          rows={4}
          disabled={disabled}
          onChange={(e) => onChange({ notes: e.target.value })}
          className={`input h-auto min-h-[96px] ${dirtyClass(isDirty('notes'))}`}
        />
      </div>
    </div>
  );
};

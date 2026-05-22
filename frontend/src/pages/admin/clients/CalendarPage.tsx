/**
 * /admin/clients/calendar — admin calendar (read-only skeleton for E.6).
 *
 * Renders four layers fetched in one shot from /api/admin/calendar/items
 * (backend route adminCalendar.js, E.3):
 *
 *   - events (galleries)              → blue solid
 *   - hour entries                    → green solid (greyed when locked)
 *   - pending quotes (not converted)  → amber dashed
 *   - pending contracts (not converted) → purple dashed
 *
 * View toggle (Month / Week) persists per admin via localStorage
 * (`utils/calendarPrefs.ts`).
 *
 * Click behaviour:
 *   - event    → /admin/events/:slug
 *   - quote    → /admin/clients/quotes/:id
 *   - contract → /admin/clients/contracts/:id
 *   - hours    → noop in E.6; E.7 adds the inline edit popover.
 *
 * Interactions deferred to E.7:
 *   - drag-create on empty slots (hour-entry create modal)
 *   - drag-resize / drag-move on unlocked hour entries
 *   - inline edit popover on hour entries
 *
 * Bundle note: this file is the entry point of the `fullcalendar` chunk
 * carved in vite.config.ts (E.5). FullCalendar's plugin imports flow
 * through here only — the calling App.tsx loads this module lazily.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import type { EventInput, DatesSetArg, EventClickArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { Card, Button, Loading } from '../../../components/common';
import { calendarService, type CalendarItem } from '../../../services/calendar.service';
import { businessProfileService } from '../../../services/businessProfile.service';
import { getCalendarView, setCalendarView, type CalendarView } from '../../../utils/calendarPrefs';

// Color tokens. Hex literals (rather than tailwind utility classes)
// because FullCalendar applies these as inline `background-color` /
// `border-color` styles on the rendered event chips — tailwind classes
// wouldn't take effect.
const COLOR_EVENT = '#3B82F6';      // blue-500
const COLOR_HOURS = '#10B981';      // emerald-500
const COLOR_HOURS_LOCKED = '#9CA3AF'; // gray-400 (greyed)
const COLOR_QUOTE_BORDER = '#F59E0B'; // amber-500
const COLOR_CONTRACT_BORDER = '#A855F7'; // purple-500

/**
 * Convert a backend CalendarItem to a FullCalendar EventInput. Embeds
 * the original item in `extendedProps` so the event-click handler can
 * read the `kind` discriminator without re-fetching.
 */
function mapItemToFcEvent(item: CalendarItem): EventInput {
  const base: EventInput = {
    id: `${item.kind}-${item.id}`,
    extendedProps: { item },
    editable: false, // E.7 flips this true for unlocked hour entries
  };

  const dateStr = (item as { eventDate?: string; entryDate?: string }).eventDate
    || (item as { entryDate?: string }).entryDate
    || '';

  if (item.kind === 'event') {
    base.title = item.eventName || 'Event';
    base.backgroundColor = COLOR_EVENT;
    base.borderColor = COLOR_EVENT;
    if (item.isFullDay || !item.eventTimeStart) {
      base.start = dateStr;
      base.allDay = true;
    } else {
      base.start = `${dateStr}T${item.eventTimeStart}`;
      base.end = item.eventTimeEnd ? `${dateStr}T${item.eventTimeEnd}` : undefined;
    }
  } else if (item.kind === 'hours') {
    // Hours always have HH:MM start + end (entered via the form).
    base.title = item.customerName
      ? `${item.customerName} — ${item.description || ''}`.trim().replace(/—\s*$/, '')
      : item.description || 'Hours';
    if (item.locked) {
      base.backgroundColor = COLOR_HOURS_LOCKED;
      base.borderColor = COLOR_HOURS_LOCKED;
      base.classNames = ['cal-hours-locked'];
    } else {
      base.backgroundColor = COLOR_HOURS;
      base.borderColor = COLOR_HOURS;
    }
    base.start = `${dateStr}T${item.startTime}`;
    base.end = `${dateStr}T${item.endTime}`;
  } else if (item.kind === 'quote') {
    base.title = item.eventName
      ? `${item.quoteNumber} — ${item.eventName}`
      : item.quoteNumber;
    base.backgroundColor = 'transparent';
    base.borderColor = COLOR_QUOTE_BORDER;
    base.textColor = COLOR_QUOTE_BORDER;
    base.classNames = ['cal-dashed'];
    if (item.eventTimeStart) {
      base.start = `${dateStr}T${item.eventTimeStart}`;
      base.end = item.eventTimeEnd ? `${dateStr}T${item.eventTimeEnd}` : undefined;
    } else {
      base.start = dateStr;
      base.allDay = true;
    }
  } else if (item.kind === 'contract') {
    base.title = item.eventName
      ? `${item.contractNumber} — ${item.eventName}`
      : item.contractNumber;
    base.backgroundColor = 'transparent';
    base.borderColor = COLOR_CONTRACT_BORDER;
    base.textColor = COLOR_CONTRACT_BORDER;
    base.classNames = ['cal-dashed'];
    if (item.eventTimeStart) {
      base.start = `${dateStr}T${item.eventTimeStart}`;
      base.end = item.eventTimeEnd ? `${dateStr}T${item.eventTimeEnd}` : undefined;
    } else {
      base.start = dateStr;
      base.allDay = true;
    }
  }
  return base;
}

/**
 * Derive an ISO YYYY-MM-DD pair covering the calendar's current visible
 * range plus a 1-week buffer on each side. The buffer keeps the cache
 * hot during week-by-week navigation so the user doesn't see a
 * loading flicker each step.
 */
function bufferedRange(active: { start: Date; end: Date }) {
  const startMs = active.start.getTime() - 7 * 24 * 60 * 60 * 1000;
  const endMs = active.end.getTime() + 7 * 24 * 60 * 60 * 1000;
  const from = new Date(startMs).toISOString().slice(0, 10);
  const to = new Date(endMs).toISOString().slice(0, 10);
  return { from, to };
}

export const CalendarPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const calendarRef = useRef<FullCalendar | null>(null);

  // View persisted in localStorage (E.5 / E.6 — utils/calendarPrefs.ts).
  const [view, setView] = useState<CalendarView>(() => getCalendarView());

  // Range owned by the calendar instance — initialised lazily once
  // FullCalendar fires its first `datesSet`. Until then the query is
  // disabled so we don't fire a request for a guessed range.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  const { data: itemsResp, isLoading: itemsLoading } = useQuery({
    queryKey: ['calendar-items', range?.from, range?.to],
    queryFn: () => calendarService.list(range as { from: string; to: string }),
    enabled: !!range,
    staleTime: 30_000, // Tight enough to feel live, loose enough to skip refetch on view nav.
  });

  // Resolve the timezone the calendar should render in. business_profile
  // .timezone wins; fall back to the browser's IANA tz.
  const { data: bpSnapshot } = useQuery({
    queryKey: ['business-profile-for-calendar'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60_000, // Settings change infrequently — long stale window.
  });
  const resolvedTz = bpSnapshot?.profile.timezone
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';

  // Map backend → FC event shape. Recomputed on every items change;
  // the cost is tiny relative to FC's render path.
  const fcEvents = useMemo(
    () => (itemsResp?.items || []).map(mapItemToFcEvent),
    [itemsResp],
  );

  // Persist view changes. We don't use FC's viewClassNames or similar
  // — the explicit toggle buttons drive both the FC instance + the
  // stored pref.
  useEffect(() => {
    setCalendarView(view);
    const api = calendarRef.current?.getApi();
    if (api && api.view.type !== view) {
      api.changeView(view);
    }
  }, [view]);

  const handleDatesSet = (arg: DatesSetArg) => {
    const next = bufferedRange({ start: arg.start, end: arg.end });
    setRange((prev) => {
      // Avoid a re-render storm: only update when the buffered range
      // actually shifts past its window.
      if (prev && prev.from === next.from && prev.to === next.to) return prev;
      return next;
    });
  };

  const handleEventClick = (arg: EventClickArg) => {
    const item = arg.event.extendedProps.item as CalendarItem | undefined;
    if (!item) return;
    if (item.kind === 'event') navigate(`/admin/events/${item.slug}`);
    else if (item.kind === 'quote') navigate(`/admin/clients/quotes/${item.id}`);
    else if (item.kind === 'contract') navigate(`/admin/clients/contracts/${item.id}`);
    // kind==='hours' → E.7 opens the inline edit popover; no-op for now.
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-theme">
            {t('calendar.pageTitle', 'Calendar')}
          </h1>
          <p className="text-sm text-muted-theme">
            {t('calendar.subtitle',
              'Events, logged hours, and pending quotes/contracts in one view.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={view === 'dayGridMonth' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setView('dayGridMonth')}
          >
            {t('calendar.viewMonth', 'Month')}
          </Button>
          <Button
            variant={view === 'timeGridWeek' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setView('timeGridWeek')}
          >
            {t('calendar.viewWeek', 'Week')}
          </Button>
        </div>
      </div>

      <Legend />

      <Card padding="md">
        {itemsLoading && !itemsResp && (
          <div className="mb-3 flex items-center gap-2 text-sm text-muted-theme">
            <Loading />
            <span>{t('calendar.loading', 'Loading items…')}</span>
          </div>
        )}
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={view}
          timeZone={resolvedTz}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: '',
          }}
          // Week starts on Monday for the operator's EU market.
          firstDay={1}
          slotMinTime="06:00:00"
          slotMaxTime="22:00:00"
          slotDuration="00:30:00"
          height="auto"
          expandRows
          events={fcEvents}
          eventClick={handleEventClick}
          datesSet={handleDatesSet}
          // Disable interactions for E.6; E.7 enables select/dragging.
          selectable={false}
          editable={false}
        />
      </Card>

      {/* Per-instance CSS for the dashed quote/contract chips. Tailwind
          can't reach inline FC chip styles, so we override with a small
          local rule. The locked-hours grey is applied via backgroundColor
          inline (above), no class needed. */}
      <style>{`
        .cal-dashed {
          border-style: dashed !important;
          background-color: transparent !important;
        }
        .cal-dashed .fc-event-title,
        .cal-dashed .fc-event-time {
          font-style: italic;
        }
        .cal-hours-locked {
          opacity: 0.7;
        }
      `}</style>
    </div>
  );
};

/**
 * Color-legend strip rendered above the calendar. Kept inline rather
 * than as a sibling component because it never reuses elsewhere and
 * sharing the COLOR_* tokens with the mapper above is cheap.
 */
const Legend: React.FC = () => {
  const { t } = useTranslation();
  return (
    <Card padding="sm">
      <div className="flex flex-wrap gap-4 text-xs text-muted-theme">
        <LegendSwatch color={COLOR_EVENT} label={t('calendar.legend.events', 'Events')} />
        <LegendSwatch color={COLOR_HOURS} label={t('calendar.legend.hours', 'Hours')} />
        <LegendSwatch
          color={COLOR_QUOTE_BORDER}
          label={t('calendar.legend.pendingQuotes', 'Pending quotes')}
          dashed
        />
        <LegendSwatch
          color={COLOR_CONTRACT_BORDER}
          label={t('calendar.legend.pendingContracts', 'Pending contracts')}
          dashed
        />
        <LegendSwatch
          color={COLOR_HOURS_LOCKED}
          label={t('calendar.legend.hoursLocked', 'Locked (billed)')}
        />
      </div>
    </Card>
  );
};

const LegendSwatch: React.FC<{ color: string; label: string; dashed?: boolean }> = ({
  color, label, dashed,
}) => (
  <div className="flex items-center gap-2">
    <span
      aria-hidden
      className="inline-block w-4 h-3 rounded-sm"
      style={{
        backgroundColor: dashed ? 'transparent' : color,
        border: dashed ? `1.5px dashed ${color}` : `1px solid ${color}`,
      }}
    />
    <span>{label}</span>
  </div>
);

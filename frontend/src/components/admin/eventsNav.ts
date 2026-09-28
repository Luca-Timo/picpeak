/**
 * Events section navigation.
 *
 * Archives used to be a top-level sidebar entry sitting next to Events. An
 * archived event is still an event, so it is a sub-page of the Events section
 * now and its URL says so (/admin/events/archives).
 *
 * There is no EventsLayout component to go with this: the Events routes are
 * flat siblings in App.tsx, and the section needs neither an index redirect
 * (Events itself is always reachable by anyone who can enter the section) nor
 * an empty state (nothing here is feature-flagged). The sidebar reads this
 * hook directly.
 */
import { useTranslation } from 'react-i18next';
import { Calendar, Archive } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { usePermissions } from '../../contexts/PermissionsContext';

export interface EventsNavItem {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  /** Permission required to reach the page behind this entry. */
  permission: string;
}

/** Sub-pages of the Events section this admin can reach. */
export function useEventsNavItems(): EventsNavItem[] {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();

  const navItems: EventsNavItem[] = [
    {
      key: 'events',
      to: '/admin/events',
      label: t('navigation.events', 'Events'),
      icon: Calendar,
      permission: 'events.view',
    },
    {
      key: 'archives',
      to: '/admin/events/archives',
      label: t('navigation.archives', 'Archives'),
      icon: Archive,
      permission: 'archives.view',
    },
  ];

  return navItems.filter((item) => hasPermission(item.permission));
}

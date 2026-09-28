/**
 * One searchable index of everywhere an admin can go.
 *
 * Every entry comes from the same hooks the sidebar renders from, so the
 * palette can never offer a page the sidebar hides — no second list to keep
 * in step. Sections contribute their sub-pages rather than the section entry
 * itself: "Archives" is what an admin is looking for, "Events section" is not.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import {
  settingsTabHref,
  useSettingsNavGroups,
} from '../../features/settings/settingsNav';
import { adminNavigation, navItemAllowed, SECTION_PATHS } from './AdminSidebar';
import { useEventsNavItems } from './eventsNav';
import { useCommunicationNavItems } from './CommunicationLayout';
import { useAutomationNavItems } from './AutomationLayout';
import { useClientsNavItems } from './ClientsLayout';
import { useAccountingNavItems } from './AccountingLayout';

export interface AdminSearchEntry {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Heading this entry is listed under, e.g. "Pages" or "Settings". */
  group: string;
  /** Where it sits, shown beside the label: "Events", "Settings › System". */
  context?: string;
  keywords?: string[];
}

export function useAdminSearchIndex(): AdminSearchEntry[] {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const { flags } = useFeatureFlags();

  const settingsGroups = useSettingsNavGroups();
  const eventsItems = useEventsNavItems();
  const communicationItems = useCommunicationNavItems();
  const automationItems = useAutomationNavItems();
  const clientsItems = useClientsNavItems();
  const accountingItems = useAccountingNavItems();

  return useMemo(() => {
    const pages = t('search.groups.pages', 'Pages');
    const entries: AdminSearchEntry[] = [];

    // Plain destinations: everything in the main menu that is not a section.
    // Sections contribute their sub-pages below instead, and the set of them
    // is declared once in AdminSidebar so this cannot fall behind it.
    const sectionPaths = new Set<string>(SECTION_PATHS);
    for (const item of adminNavigation) {
      if (sectionPaths.has(item.href)) continue;
      if (!navItemAllowed(item, hasPermission, flags)) continue;
      entries.push({
        key: `nav:${item.href}`,
        label: t(item.nameKey),
        href: item.href,
        icon: item.icon as LucideIcon,
        group: pages,
      });
    }

    const pushSection = (
      context: string,
      items: { key: string; to: string; label: string; icon: LucideIcon }[],
    ) => {
      for (const i of items) {
        entries.push({
          key: `${context}:${i.key}`,
          label: i.label,
          href: i.to,
          icon: i.icon,
          group: pages,
          context,
        });
      }
    };
    pushSection(t('navigation.events', 'Events'), eventsItems);
    pushSection(t('navigation.communication', 'Communication'), communicationItems);
    pushSection(t('navigation.clients', 'CRM'), clientsItems);
    pushSection(t('navigation.accounting', 'Accounting'), accountingItems);
    pushSection(t('navigation.automation', 'Automation'), automationItems);

    const settingsLabel = t('navigation.settings', 'Settings');
    for (const group of settingsGroups) {
      for (const item of group.items) {
        entries.push({
          key: `settings:${item.key}`,
          label: item.label,
          href: settingsTabHref(item.key),
          icon: item.icon,
          group: settingsLabel,
          context: `${settingsLabel} › ${group.label}`,
          keywords: item.keywords,
        });
      }
    }

    return entries;
  }, [t, hasPermission, flags, settingsGroups, eventsItems, communicationItems,
      automationItems, clientsItems, accountingItems]);
}

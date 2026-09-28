/**
 * Communication section layout.
 *
 * Messages (the admin mail client) and PicTransfer were both top-level
 * sidebar entries. They are the two surfaces for reaching a client directly,
 * so they share a section, mirroring ClientsLayout / AccountingLayout: the
 * sidebar renders the navigation from `useCommunicationNavItems()` while the
 * admin is inside /admin/communication, and this layout owns only the
 * section-root redirect and the empty state.
 *
 * Newsletters deliberately stays in the CRM section. It reads as a
 * Communication surface, but it is wired into the `clients` feature-flag
 * derivation and the customer detail page hosts its consent control (#1264) —
 * moving it is a data-model change wearing a navigation change's clothes.
 */
import React from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Mail, Send, MessagesSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';

export interface CommunicationNavItem {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  /** Feature flag that must be ON for this entry to render. */
  featureFlag: FeatureKey;
  /**
   * Permission required to reach the page behind this entry. Without it the
   * entry would render for anyone who can enter the section at all and the
   * click would land on a backend 403 — the failure mode #1264 fixed for the
   * CRM section.
   */
  permission: string;
}

/** Sub-pages of the Communication section that are switched on and permitted. */
export function useCommunicationNavItems(): CommunicationNavItem[] {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  const { hasPermission } = usePermissions();

  const navItems: CommunicationNavItem[] = [
    {
      key: 'messages',
      to: '/admin/communication/messages',
      label: t('navigation.messages', 'Messages'),
      icon: Mail,
      featureFlag: 'messaging',
      permission: 'email.view',
    },
    {
      key: 'transfers',
      to: '/admin/communication/transfers',
      label: t('navigation.transfers', 'PicTransfer'),
      icon: Send,
      featureFlag: 'transfers',
      permission: 'events.view',
    },
  ];

  return navItems.filter((item) => flags[item.featureFlag] && hasPermission(item.permission));
}

/**
 * Is any sub-feature of this section switched on, regardless of whether this
 * admin may open it?
 *
 * The empty state needs the distinction: "nothing is enabled" and "you cannot
 * open any of what is enabled" are different problems, and telling the second
 * admin to go and enable the feature they just arrived from — via a bookmark
 * to the old top-level path — is advice they cannot act on.
 */
export function useCommunicationSectionHasFlag(): boolean {
  const { flags } = useFeatureFlags();
  return (['messaging', 'transfers'] as FeatureKey[]).some((f) => flags[f]);
}

export const CommunicationLayout: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const anyFlagOn = useCommunicationSectionHasFlag();
  const enabledItems = useCommunicationNavItems();

  // /admin/communication has no page of its own — land on the first entry
  // this admin can actually open rather than a fixed target they may lack the
  // permission or the flag for.
  const isSectionRoot = location.pathname.replace(/\/+$/, '') === '/admin/communication';
  if (isSectionRoot && enabledItems.length > 0) {
    return <Navigate to={enabledItems[0].to} replace />;
  }

  if (enabledItems.length === 0) {
    // Two different empty states. With the flags off, the admin is one toggle
    // away and the message says so. With the flags on, the section is empty
    // because this role may not open any page in it — usually arriving here
    // from a bookmark to the old top-level path — and pointing them at
    // Settings → Features would be advice they cannot act on.
    const title = anyFlagOn
      ? t('communication.empty.noAccessTitle', 'Nothing here you can open')
      : t('communication.empty.title', 'No communication features enabled');
    const description = anyFlagOn
      ? t('communication.empty.noAccessBody', 'These features are switched on, but your role cannot open any of their pages. Ask an administrator for access.')
      : t('communication.empty.body', 'Enable Messages or PicTransfer under Settings → Features to get started.');
    return (
      <div>
        <div className="rounded-xl border border-dashed border-line-strong bg-shell p-8 text-center">
          <MessagesSquare className="w-10 h-10 mx-auto mb-3 text-neutral-400" />
          <h2 className="text-lg font-semibold text-heading mb-1">{title}</h2>
          <p className="text-sm text-soft">{description}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
};

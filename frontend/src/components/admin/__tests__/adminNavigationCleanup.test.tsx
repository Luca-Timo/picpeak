/**
 * The admin navigation cleanup.
 *
 * Six surfaces stopped being top-level sidebar entries — Archives, Messages,
 * PicTransfer, Workflows, Users and System health — and moved into sections
 * or into Settings. Three things are easy to break here and all three are
 * invisible until someone hits them:
 *
 *  1. an entry reappearing at the top level, undoing the cleanup;
 *  2. a section entry showing when the section has nothing inside it (or
 *     hiding when it has), which strands a role on an empty page;
 *  3. a moved URL losing its redirect, which 404s bookmarks and links in
 *     already-sent email.
 */
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Labels resolve to their key so assertions read as keys. Keyword lookups ask
// for an array, so they get one: a fixture here, with the real bundle checked
// separately below — otherwise this file would pass with en.json emptied.
const KEYWORD_FIXTURE: Record<string, string[]> = {
  'settings.keywords.email': ['smtp', 'imap', 'mail server'],
};
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { returnObjects?: boolean }) =>
      (opts?.returnObjects ? (KEYWORD_FIXTURE[key] ?? []) : key),
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

let granted = new Set<string>();
let flags: Record<string, boolean> = {};

vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: (p: string) => granted.has(p),
    hasAnyPermission: (perms: string[]) => perms.some((p) => granted.has(p)),
    isLoading: false,
  }),
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags }),
}));
vi.mock('../../../contexts/AdminDarkModeContext', () => ({
  useAdminDarkMode: () => ({ isDark: false }),
}));
vi.mock('../../../contexts/UnsavedChangesContext', () => ({
  useLeaveGuard: () => ({ confirmLeave: async () => true, isAnyDirty: false }),
}));
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: undefined }),
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: { getStorageInfo: vi.fn().mockResolvedValue(undefined), formatBytes: () => '0 B' },
}));
vi.mock('../VersionInfo', () => ({ VersionInfo: () => null }));

import { AdminSidebar } from '../AdminSidebar';
import { CommunicationLayout } from '../CommunicationLayout';

/** Every permission the sidebar and its section hooks ever ask about. */
const ALL_PERMISSIONS = [
  'events.view', 'archives.view', 'email.view', 'workflows.view', 'analytics.view',
  'settings.view', 'users.view', 'customers.view', 'newsletters.view', 'accounting.view',
];

function renderSidebar(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AdminSidebar isOpen onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); granted = new Set(); flags = {}; });

describe('admin sidebar — what is top level', () => {
  it('does not offer the six relocated surfaces as main-menu entries', () => {
    granted = new Set(ALL_PERMISSIONS);
    // Everything on, so nothing can be absent merely for being switched off.
    flags = {
      messaging: true, transfers: true, workflows: true, reminderEmails: true,
      analytics: true, userManagement: true, accounting: true,
    };
    renderSidebar('/admin/dashboard');

    for (const key of [
      'navigation.archives', 'navigation.messages', 'navigation.transfers',
      'navigation.workflows', 'navigation.users', 'navigation.systemHealth',
    ]) {
      expect(screen.queryByText(key)).not.toBeInTheDocument();
    }

    // …and the entries that replaced them are there.
    expect(screen.getByText('navigation.events')).toBeInTheDocument();
    expect(screen.getByText('navigation.communication')).toBeInTheDocument();
    expect(screen.getByText('navigation.automation')).toBeInTheDocument();
    expect(screen.getByText('navigation.settings')).toBeInTheDocument();
  });

  it('hides a section entry when the role or the flags leave it empty', () => {
    granted = new Set(['events.view']); // no email.view, so Messages is unreachable
    flags = { messaging: true, transfers: false };
    renderSidebar('/admin/dashboard');

    // The flag is on, but this role cannot open the only page inside — the
    // entry must not lead them to an empty section.
    expect(screen.queryByText('navigation.communication')).not.toBeInTheDocument();
  });

  it('shows Communication as soon as one sub-feature is reachable', () => {
    granted = new Set(['events.view']);
    flags = { messaging: false, transfers: true }; // PicTransfer needs events.view
    renderSidebar('/admin/dashboard');

    expect(screen.getByText('navigation.communication')).toBeInTheDocument();
  });
});

describe('a section entry has to lead somewhere the role can open', () => {
  it('aims Events at Archives for a role that only holds archives.view', () => {
    // Before the cleanup this role saw a top-level Archives entry pointing
    // straight at /admin/archives. Events is now the section that contains
    // Archives, so the entry appears — but /admin/events is the events list,
    // which 403s without events.view. The entry must aim at the first item
    // this role can actually open, not at the section root.
    granted = new Set(['archives.view']);
    renderSidebar('/admin/dashboard');

    const entry = screen.getByText('navigation.events').closest('a');
    expect(entry).toHaveAttribute('href', '/admin/events/archives');
  });

  it('still aims Events at the events list for a role that can see it', () => {
    granted = new Set(['events.view', 'archives.view']);
    renderSidebar('/admin/dashboard');

    const entry = screen.getByText('navigation.events').closest('a');
    expect(entry).toHaveAttribute('href', '/admin/events');
  });
});

describe('an empty section says which kind of empty it is', () => {
  const renderCommunication = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/admin/communication/messages']}>
        <CommunicationLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  it('offers the feature toggle when the flags are off', () => {
    granted = new Set(ALL_PERMISSIONS);
    flags = { messaging: false, transfers: false };
    renderCommunication();
    expect(screen.getByText('communication.empty.title')).toBeInTheDocument();
  });

  it('does not tell a role to enable features that are already on', () => {
    // Reached by a bookmark to the old /admin/messages path. Pointing this
    // admin at Settings > Features is advice they cannot act on: the features
    // are on, and they are not permitted to open the pages.
    granted = new Set(['events.view']); // neither email.view nor a transfers route
    flags = { messaging: true, transfers: false };
    renderCommunication();
    expect(screen.getByText('communication.empty.noAccessTitle')).toBeInTheDocument();
    expect(screen.queryByText('communication.empty.title')).not.toBeInTheDocument();
  });
});

describe('admin sidebar — sections', () => {
  it('takes the menu over on an Events sub-page and marks only the deepest match', () => {
    granted = new Set(ALL_PERMISSIONS);
    renderSidebar('/admin/events/archives');

    const archives = screen.getByText('navigation.archives').closest('a');
    expect(archives).toHaveAttribute('aria-current', 'page');

    // /admin/events is a prefix of /admin/events/archives, so a naive prefix
    // test would light up Events here too.
    const eventsLinks = screen.getAllByText('navigation.events')
      .map((n) => n.closest('a')).filter(Boolean);
    for (const link of eventsLinks) {
      expect(link).not.toHaveAttribute('aria-current', 'page');
    }
  });
});

describe('settings search', () => {
  it('filters the Settings section and finds a tab by keyword, not just by title', () => {
    granted = new Set(ALL_PERMISSIONS);
    renderSidebar('/admin/settings?tab=features');

    const box = screen.getByLabelText('settings.search.label');
    expect(screen.getByText('settings.email.title')).toBeInTheDocument();

    // "smtp" appears in no tab label — only in the Email tab's keywords.
    fireEvent.change(box, { target: { value: 'smtp' } });
    expect(screen.getByText('settings.email.title')).toBeInTheDocument();
    expect(screen.queryByText('settings.branding.title')).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'zzzznope' } });
    expect(screen.getByText('settings.search.noResults')).toBeInTheDocument();
  });

  it('ships the keyword bundle the search reads, in both authored locales', () => {
    // The test above runs on a fixture, so it would keep passing if the real
    // terms were dropped. en and de are the authored pair; the rest inherit
    // English through i18next's fallbackLng.
    const load = (loc: string) =>
      JSON.parse(readFileSync(resolve(__dirname, `../../../i18n/locales/${loc}.json`), 'utf8'))
        ?.settings?.keywords ?? {};
    const en = load('en');
    const de = load('de');

    expect(en.email).toContain('smtp');
    expect(de.cms).toContain('impressum');
    // Parity in both directions is what the maintainer checks.
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
  });
});

describe('moved URLs keep working', () => {
  // Source-level, deliberately: mounting the whole route tree to prove a
  // redirect exists costs more than it catches, and what actually regresses
  // is someone deleting the line.
  const app = readFileSync(resolve(__dirname, '../../../App.tsx'), 'utf8');

  it.each([
    ['archives', '/admin/events/archives'],
    ['messages', '/admin/communication/messages'],
    ['transfers', '/admin/communication/transfers'],
    ['workflows', '/admin/automation/workflows'],
    ['workflows/approvals', '/admin/automation/approvals'],
    ['users', '/admin/settings?tab=users'],
    ['system-health', '/admin/settings?tab=health'],
  ])('/admin/%s redirects to %s', (from, to) => {
    const pattern = new RegExp(
      `path="${from.replace(/\//g, '\\/')}"\\s+element=\\{<Navigate to="${to.replace(/[?]/g, '\\?')}" replace \\/>\\}`,
    );
    expect(app).toMatch(pattern);
  });

  it('keeps the workflow editor deep link working with its id', () => {
    expect(app).toMatch(/path="workflows\/:id"\s+element=\{<RedirectWorkflowEditor \/>\}/);
    expect(app).toMatch(/\/admin\/automation\/workflows\/\$\{id\}/);
  });

  it('redirects the reminder-templates settings tab to its new home', () => {
    // Above SettingsPage, not inside it: inside, it lost a race with that
    // page's URL-sync effect, which rewrites an unknown ?tab= to the default.
    expect(app).toMatch(/function SettingsRoute\(\)/);
    expect(app).toMatch(/params\.get\('tab'\) === 'reminderTemplates'/);
    expect(app).toMatch(/<Navigate to="\/admin\/automation\/reminder-templates" replace \/>/);
    expect(app).toMatch(/path="settings" element=\{<SettingsRoute \/>\}/);
  });
});

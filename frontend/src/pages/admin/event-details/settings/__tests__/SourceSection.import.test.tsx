/**
 * Settings → Photo source offers Import now / Rescan for the saved external
 * folder, the same action as the Photos tab. A folder picked but not saved
 * yet cannot be imported (the server imports from the saved one), so the
 * button waits and says to save first.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SourceSection } from '../sections';
import { eventFieldsFromEvent } from '../draft';
import type { Event } from '../../../../../types';

const imp = vi.hoisted(() => ({
  canImport: true, running: false, failed: false, failureText: 'failed', statusText: 'Not scanned yet',
  buttonLabel: 'Import now', canRun: true, run: vi.fn(),
}));

vi.mock('../../useExternalImport', () => ({ useExternalImport: () => imp }));
vi.mock('../../ExternalFolderPicker', () => ({ ExternalFolderPicker: () => null }));
vi.mock('../../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const saved = { id: 7, source_mode: 'reference', external_path: 'shoot/export' } as unknown as Event;

function renderSection(event: Event, patch: Record<string, unknown> = {}) {
  const f = { ...eventFieldsFromEvent(event, null), ...patch };
  return render(<SourceSection f={f} set={() => {}} event={event} />);
}

const button = () => screen.queryByRole('button', { name: /Import now|Rescan|Try again/ });

describe('SourceSection — import from the saved folder', () => {
  beforeEach(() => {
    Object.assign(imp, { canImport: true, running: false, failed: false, canRun: true, buttonLabel: 'Import now', statusText: 'Not scanned yet' });
    imp.run.mockClear();
  });

  it('runs the import for the saved folder and shows its status', () => {
    renderSection(saved);
    expect(screen.getByText('Not scanned yet')).toBeInTheDocument();
    fireEvent.click(button()!);
    expect(imp.run).toHaveBeenCalledTimes(1);
  });

  it('waits for a newly picked folder to be saved', () => {
    renderSection(saved, { external_path: 'another/folder' });
    expect(screen.getByText('Save the new folder first, then import it here.')).toBeInTheDocument();
    expect(button()).toBeDisabled();
  });

  it('waits when the gallery switches to an external folder that is not saved yet', () => {
    renderSection({ id: 8, source_mode: 'managed', external_path: null } as unknown as Event, { source_mode: 'reference', external_path: 'new' });
    expect(button()).toBeDisabled();
  });

  it('shows the failure of the last run', () => {
    Object.assign(imp, { failed: true, buttonLabel: 'Try again' });
    renderSection(saved);
    expect(screen.getByRole('alert')).toHaveTextContent('failed');
    expect(button()).toHaveTextContent('Try again');
  });

  it('has no button without the permission to import photos', () => {
    imp.canImport = false;
    renderSection(saved);
    expect(button()).toBeNull();
  });
});

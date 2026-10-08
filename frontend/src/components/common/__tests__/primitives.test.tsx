import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { Badge } from '../Badge';
import { Notice } from '../Notice';
import { Modal } from '../Modal';
import { Tabs } from '../Tabs';
import { Switch } from '../Switch';
import { ErrorState } from '../EmptyState';
import { applyStatusColors, normalizeStatusColors } from '../../../utils/statusColors';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

describe('Badge', () => {
  it('reads the status tokens for its tone, never a raw palette', () => {
    render(<Badge tone="danger">Overdue</Badge>);
    const badge = screen.getByText('Overdue');
    expect(badge.className).toContain('bg-danger-soft');
    expect(badge.className).toContain('text-danger-text');
    expect(badge.className).not.toMatch(/red-\d/);
  });

  it('has an outline look for states that are not there yet', () => {
    render(<Badge tone="neutral" appearance="outline">Roadmap</Badge>);
    expect(screen.getByText('Roadmap').className).toContain('border-line-strong');
  });
});

describe('Notice', () => {
  it('is an alert when it reports a failure and a status otherwise', () => {
    const { rerender } = render(<Notice tone="danger">Import failed</Notice>);
    expect(screen.getByRole('alert')).toHaveTextContent('Import failed');
    rerender(<Notice tone="info">Read-only</Notice>);
    expect(screen.getByRole('status')).toHaveTextContent('Read-only');
  });
});

describe('Modal', () => {
  const Harness = () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Modal open={open} onClose={() => setOpen(false)} title="Rename gallery">
          <input aria-label="Name" />
        </Modal>
      </>
    );
  };

  it('labels itself, focuses inside, closes on Escape and gives focus back', () => {
    render(<Harness />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Rename gallery' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Tabs', () => {
  it('moves with the arrow keys and marks the selected tab', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        items={[{ id: 'overview', label: 'Overview' }, { id: 'settings', label: 'Settings', dirty: true, dirtyLabel: 'Unsaved' }]}
        value="overview"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('settings');
    expect(screen.getByRole('img', { name: 'Unsaved' })).toBeInTheDocument();
  });
});

describe('Switch', () => {
  it('flips through its visible label', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Watch this folder" />);
    const control = screen.getByRole('switch', { name: 'Watch this folder' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('ErrorState', () => {
  it('offers Retry', () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('status colours', () => {
  it('writes the picked hues on <html> and clears the rest', () => {
    const root = document.documentElement;
    applyStatusColors({ danger: '#ff0000' });
    expect(root.style.getPropertyValue('--status-danger')).toBe('#ff0000');
    applyStatusColors(normalizeStatusColors({ danger: 'not-a-colour' }));
    expect(root.style.getPropertyValue('--status-danger')).toBe('');
  });
});

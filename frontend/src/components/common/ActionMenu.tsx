import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';

export interface ActionMenuItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Destructive: shown in the danger colour, after a divider. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface ActionMenuProps {
  items: ActionMenuItem[];
  /** The side the dropdown is anchored to. */
  align?: 'left' | 'right';
  label?: string;
  className?: string;
}

/**
 * The ⋯ menu of an entity header: the secondary actions, out of the way
 * (UX.md § 1). Escape and a click outside close it; an empty menu is not
 * rendered. Destructive items go last, after a divider.
 */
export const ActionMenu: React.FC<ActionMenuProps> = ({ items, align = 'right', label, className }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  const regular = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);
  const row = (item: ActionMenuItem) => (
    <button
      key={item.key}
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={() => { setOpen(false); item.onSelect(); }}
      className={clsx(
        'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left hover:bg-hover disabled:opacity-50 disabled:pointer-events-none',
        item.danger ? 'text-danger-text' : 'text-body',
        '[&>svg]:w-4 [&>svg]:h-4',
      )}
    >
      {item.icon}
      {item.label}
    </button>
  );
  return (
    <div className={clsx('relative', className)} ref={ref}>
      <Button
        variant="outline"
        size="icon-md"
        aria-label={label || t('common.moreActions', 'More actions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal className="w-4 h-4" />
      </Button>
      {open && (
        <div
          role="menu"
          className={clsx(
            'absolute top-full mt-1 z-30 w-64 rounded-lg border border-line bg-panel shadow-lg p-1',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {regular.map(row)}
          {regular.length > 0 && danger.length > 0 && <div className="my-1 h-px bg-line" role="separator" />}
          {danger.map(row)}
        </div>
      )}
    </div>
  );
};

/**
 * Reusable line-items editor for quotes + invoices.
 *
 * Columns: Pos / Anzahl / Beschreibung / Einzelpreis / (optional Rabatt) /
 * Gesamt. Live-computed line totals + grand total displayed below. The
 * server is the source of truth for totals — this is just for editor
 * UX. Adding rows / reordering / removing rows mutates the array via
 * the parent's setter.
 *
 * Money values are stored in MAJOR units in the form state (e.g. 250.00)
 * for editor ergonomics, then converted to minor (25000) when persisting.
 * The conversion happens at the save boundary in the parent page.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, ArrowUp, ArrowDown, Save as SaveIcon } from 'lucide-react';
import { Button } from '../common';

export interface EditableLineItem {
  id?: number;
  position: number;
  quantity: number;
  description: string;
  /** Stored in major units (CHF / EUR) for UX. */
  unitPrice: number;
  discountPercent: number;
}

export interface LineItemPresetMinimal {
  id: number;
  name: string;
  description: string;
  unitPriceMinor: number;
  quantityDefault: number;
}

interface Props {
  items: EditableLineItem[];
  currency: string;
  showDiscount?: boolean;
  vatRate?: number;
  shippingAmount?: number;
  onChange: (items: EditableLineItem[]) => void;
  presets?: LineItemPresetMinimal[];
  onSaveAsPreset?: (item: EditableLineItem) => void;
}

function formatMoney(amount: number, currency: string, locale = 'de-CH') {
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: (currency || 'CHF').toUpperCase(),
  }).format(amount);
}

export const LineItemsTable: React.FC<Props> = ({
  items, currency, showDiscount = true, vatRate = 0, shippingAmount = 0,
  onChange, presets = [], onSaveAsPreset,
}) => {
  const { t } = useTranslation();

  const setItem = (idx: number, patch: Partial<EditableLineItem>) => {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    onChange(next);
  };

  const addRow = (preset?: LineItemPresetMinimal) => {
    const next = [...items, {
      position: items.length + 1,
      quantity: preset ? Number(preset.quantityDefault) || 1 : 1,
      description: preset ? `${preset.name}${preset.description ? `\n${preset.description}` : ''}` : '',
      unitPrice: preset ? Number(preset.unitPriceMinor) / 100 : 0,
      discountPercent: 0,
    }];
    onChange(next);
  };

  const removeRow = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx).map((it, i) => ({ ...it, position: i + 1 })));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next.map((it, i) => ({ ...it, position: i + 1 })));
  };

  const lineTotal = (li: EditableLineItem) =>
    Math.round(li.quantity * li.unitPrice * (1 - li.discountPercent / 100) * 100) / 100;
  const subtotal = items.reduce((s, li) => s + lineTotal(li), 0);
  const vatAmount = Math.round(subtotal * vatRate) / 100;
  const total = subtotal + vatAmount + (Number(shippingAmount) || 0);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
            <tr>
              <th className="px-2 py-2 text-left w-12">{t('crm.lineItems.position', 'Pos.')}</th>
              <th className="px-2 py-2 text-left w-20">{t('crm.lineItems.quantity', 'Anzahl')}</th>
              <th className="px-2 py-2 text-left">{t('crm.lineItems.description', 'Beschreibung')}</th>
              <th className="px-2 py-2 text-right w-28">{t('crm.lineItems.unitPrice', 'Einzelpreis')}</th>
              {showDiscount && (
                <th className="px-2 py-2 text-right w-24">{t('crm.lineItems.discount', 'Rabatt %')}</th>
              )}
              <th className="px-2 py-2 text-right w-28">{t('crm.lineItems.total', 'Summe')}</th>
              <th className="px-2 py-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((li, idx) => (
              <tr key={idx} className="border-t border-neutral-200 dark:border-neutral-700">
                <td className="px-2 py-2 text-neutral-600 dark:text-neutral-400">{idx + 1}</td>
                <td className="px-2 py-2">
                  <input
                    type="number" step="0.01" min="0"
                    className="w-20 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-sm"
                    value={li.quantity}
                    onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })}
                  />
                </td>
                <td className="px-2 py-2">
                  <textarea
                    rows={2}
                    className="w-full rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-sm"
                    value={li.description}
                    onChange={(e) => setItem(idx, { description: e.target.value })}
                    placeholder={t('crm.lineItems.descriptionPlaceholder', 'Description (multi-line OK)') as string}
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    type="number" step="0.01" min="0"
                    className="w-24 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-sm text-right"
                    value={li.unitPrice}
                    onChange={(e) => setItem(idx, { unitPrice: Number(e.target.value) })}
                  />
                </td>
                {showDiscount && (
                  <td className="px-2 py-2">
                    <input
                      type="number" step="0.1" min="0" max="100"
                      className="w-20 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-sm text-right"
                      value={li.discountPercent}
                      onChange={(e) => setItem(idx, { discountPercent: Number(e.target.value) })}
                    />
                  </td>
                )}
                <td className="px-2 py-2 text-right font-medium tabular-nums">
                  {formatMoney(lineTotal(li), currency)}
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center gap-1 justify-end">
                    <button type="button" onClick={() => move(idx, -1)} aria-label="Move up"
                      className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30"
                      disabled={idx === 0}><ArrowUp className="w-4 h-4" /></button>
                    <button type="button" onClick={() => move(idx, 1)} aria-label="Move down"
                      className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30"
                      disabled={idx === items.length - 1}><ArrowDown className="w-4 h-4" /></button>
                    {onSaveAsPreset && (
                      <button type="button" onClick={() => onSaveAsPreset(li)} aria-label="Save as preset"
                        className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
                        title={t('crm.lineItems.saveAsPreset', 'Save as preset') as string}><SaveIcon className="w-4 h-4" /></button>
                    )}
                    <button type="button" onClick={() => removeRow(idx)} aria-label="Remove"
                      className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600"
                    ><X className="w-4 h-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={showDiscount ? 7 : 6} className="px-2 py-6 text-center text-neutral-500">
                {t('crm.lineItems.empty', 'No line items yet — add one to get started.')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => addRow()}>
          <Plus className="w-4 h-4 mr-1" />{t('crm.lineItems.addRow', 'Add row')}
        </Button>
        {presets.length > 0 && (
          <select
            className="text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-1.5"
            onChange={(e) => {
              const id = parseInt(e.target.value, 10);
              const preset = presets.find((p) => p.id === id);
              if (preset) addRow(preset);
              e.target.value = '';
            }}
            defaultValue=""
          >
            <option value="" disabled>{t('crm.lineItems.addFromPreset', 'Add from preset…')}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-col items-end gap-1 text-sm pt-2 border-t border-neutral-200 dark:border-neutral-700">
        <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('crm.lineItems.subtotal', 'Subtotal')}:</span><span className="tabular-nums w-28 text-right">{formatMoney(subtotal, currency)}</span></div>
        <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('crm.lineItems.vat', 'VAT')} ({(vatRate * 1).toFixed(1)}%):</span><span className="tabular-nums w-28 text-right">{formatMoney(vatAmount, currency)}</span></div>
        {!!shippingAmount && (
          <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('crm.lineItems.shipping', 'Shipping')}:</span><span className="tabular-nums w-28 text-right">{formatMoney(shippingAmount, currency)}</span></div>
        )}
        <div className="flex gap-6 font-semibold text-base"><span>{t('crm.lineItems.total', 'Total')}:</span><span className="tabular-nums w-28 text-right">{formatMoney(total, currency)}</span></div>
      </div>
    </div>
  );
};

export { formatMoney };

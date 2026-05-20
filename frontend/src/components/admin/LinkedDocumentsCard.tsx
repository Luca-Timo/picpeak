/**
 * Shared "Linked documents" card surface for the three CRM document
 * detail pages (Quote / Contract / Invoice). Renders a uniform card
 * with a "Linked documents" heading and a list of labeled lineage
 * rows (e.g. "From quote", "Linked contract", "Resulting invoices").
 *
 * Readability:
 *   - Label colour is `text-neutral-600 dark:text-neutral-300` — both
 *     halves clear the WCAG AA bar against the card surfaces used in
 *     light + dark mode (Card uses neutral-0 / neutral-900).
 *   - Status pill next to a value uses neutral-700 / neutral-300 so
 *     it's legible without competing visually with the link.
 *   - Label column has a fixed pixel width on md+ so multi-row labels
 *     line up vertically; on small screens labels stack above values.
 *
 * The component is intentionally render-prop free: each detail page
 * builds its own `items` array because the data shapes (sourceQuote
 * vs convertedContract vs cancelsInvoice etc.) are too varied to
 * shoehorn into a generic shape without losing type safety. The
 * card itself stays consistent.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '../common';

export interface LinkedDocumentLink {
  /** Display text — usually the human number (e.g. "LBM-C-2026-0010"). */
  label: string;
  /** Where clicking goes (usually a detail-page route). */
  to: string;
  /** Optional short status tag rendered to the right of the link
   *  (e.g. "Scheduled" / "Paid"). Already-translated string. */
  status?: string;
}

export interface LinkedDocumentRow {
  /** Already-translated label, displayed in the left column. */
  label: string;
  /** One or more links rendered on the right. Use a single-element
   *  array for one-of relationships, multi-element for collections
   *  (e.g. "Resulting invoices"). */
  links: LinkedDocumentLink[];
}

interface LinkedDocumentsCardProps {
  /** Rows to render. Pre-filter empty rows in the caller — the card
   *  itself doesn't render at all when `rows` is empty. */
  rows: LinkedDocumentRow[];
  /** Optional className passthrough for spacing tweaks. */
  className?: string;
}

export const LinkedDocumentsCard: React.FC<LinkedDocumentsCardProps> = ({ rows, className = '' }) => {
  const { t } = useTranslation();
  if (rows.length === 0) return null;

  return (
    <Card padding="lg" className={className}>
      <h2 className="font-semibold mb-3 text-neutral-900 dark:text-neutral-100">
        {t('linkedDocuments.title', 'Linked documents')}
      </h2>
      <div className="space-y-2 text-sm">
        {rows.map((row, idx) => (
          <div
            key={`${row.label}-${idx}`}
            // Stack on small screens (label above value); side-by-side
            // on md+. items-start so multi-link collections (Resulting
            // invoices, multiple entries) align cleanly with the label.
            className="flex flex-col md:flex-row md:items-start md:gap-3"
          >
            <span className="text-neutral-600 dark:text-neutral-300 md:w-40 md:flex-shrink-0">
              {row.label}:
            </span>
            <div className="flex flex-col gap-1">
              {row.links.map((link, lidx) => (
                <div key={`${link.to}-${lidx}`} className="flex items-center gap-2">
                  <Link
                    to={link.to}
                    className="font-mono text-accent-dark hover:underline"
                  >
                    {link.label}
                  </Link>
                  {link.status && (
                    <span className="text-xs text-neutral-700 dark:text-neutral-300 px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800">
                      {link.status}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

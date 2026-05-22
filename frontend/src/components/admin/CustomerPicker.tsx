/**
 * CustomerPicker — shared search-or-create surface for the three CRM
 * editors (Quote, Bill, Contract).
 *
 * **Why this exists**
 *
 * The audit flagged that QuoteEditorPage, BillEditorPage, and
 * ContractEditorPage each carried near-identical ~80-line customer
 * picker blocks: a "currently selected" row when an id is present,
 * a search-debounced lookup with passive-badge chips, and an
 * "InlineCustomerCreate" expansion when the admin clicks "+ Create
 * new customer". The three copies had drifted: passive badge text
 * positioning differed, the contract variant used a bare `<input>`
 * instead of the shared `<Input>` component, and the contract change
 * link used `text-accent-dark hover:underline` instead of the
 * Button-variant "outline" style the other two used.
 *
 * Behavior unified here matches the Quote and Bill variants (which
 * were already in sync with each other); the contract variant's
 * styling differences are folded in.
 *
 * **API**
 *
 *   <CustomerPicker
 *     value={customerAccountId}        // number | null
 *     label={customerLabel}            // pre-formatted display label
 *     isPassive={customerIsPassive}    // boolean
 *     onSelect={(c) => { ... }}        // CustomerSummary from search
 *     onCreate={(c) => { ... }}        // CustomerAccountDetail from inline create
 *     onClear={() => { ... }}          // user clicked "Change"
 *     readOnly={false}                 // contract editor uses true on edit
 *   />
 *
 * The component owns the `customerSearch` state + the debounced
 * useQuery against customerAdminService.search and the "+ Create new
 * customer" expansion toggle. Parents own the canonical
 * `customerAccountId / label / isPassive` triple because each editor
 * stores them differently (Quote nests them inside a form object,
 * Bill + Contract use separate useStates). Keeping the triple owned
 * by the parent avoids a forced shape migration.
 *
 * **Selection vs creation callbacks**
 *
 * `onSelect` receives the CustomerSummary shape from the search
 * endpoint (id, email, displayName, companyName, firstName, lastName,
 * isPassive). `onCreate` receives the full CustomerAccountDetail
 * because some editors want to inherit additional fields from a
 * freshly-created customer (e.g. Quote inherits the new customer's
 * preferredLanguage so the doc renders in their locale by default).
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button, Input } from '../common';
import { InlineCustomerCreate } from './InlineCustomerCreate';
import {
  customerAdminService,
  type CustomerAccountDetail,
  type CustomerAccountSummary,
} from '../../services/customerAdmin.service';

// Alias for clarity at the call-site: search returns the Summary shape.
export type CustomerSummary = CustomerAccountSummary;

export interface CustomerPickerProps {
  value: number | null;
  label: string;
  isPassive: boolean;
  onSelect: (customer: CustomerSummary) => void;
  onCreate: (customer: CustomerAccountDetail) => void;
  onClear: () => void;
  /**
   * Read-only mode: render only the selected-row chip, hide search +
   * create + change. Used by the contract editor in edit mode where
   * the customer is locked to whatever the contract was created with.
   */
  readOnly?: boolean;
  /**
   * Placeholder override for the search box. Defaults to the i18n
   * `crm.customerPicker.search` key with an EN fallback. Specific
   * editors can pass a doc-type-flavoured label.
   */
  searchPlaceholder?: string;
}

export const CustomerPicker: React.FC<CustomerPickerProps> = ({
  value,
  label,
  isPassive,
  onSelect,
  onCreate,
  onClear,
  readOnly = false,
  searchPlaceholder,
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const { data: options = [] } = useQuery({
    queryKey: ['crm-customer-picker', search],
    queryFn: () => customerAdminService.search(search),
    enabled: !readOnly && !value && !creating && search.trim().length >= 2,
  });

  if (value) {
    return (
      <div className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-800 rounded-md px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm">{label || `#${value}`}</span>
          {isPassive && (
            <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300">
              {t('customers.passive.badge', 'Passive — admin only')}
            </span>
          )}
        </div>
        {!readOnly && (
          <Button variant="outline" size="sm" onClick={onClear}>
            {t('common.change', 'Change')}
          </Button>
        )}
      </div>
    );
  }

  if (creating) {
    return (
      <InlineCustomerCreate
        onCancel={() => setCreating(false)}
        onCreated={(c) => {
          onCreate(c);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <>
      <Input
        placeholder={searchPlaceholder
          || (t('crm.customerPicker.search', 'Search customer by email or company…') as string)}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {options.length > 0 && (
        <ul className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-700 divide-y divide-neutral-200 dark:divide-neutral-700">
          {options.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c)}
                className="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-sm"
              >
                <span className="font-medium">
                  {c.companyName || c.displayName || c.email}
                </span>
                <span className="text-neutral-500 ml-2">{c.email}</span>
                {c.isPassive && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300">
                    {t('customers.passive.badge', 'Passive — admin only')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="mt-3 inline-flex items-center gap-1 text-sm text-primary-600 dark:text-primary-400 hover:underline"
      >
        {t('customers.create.openLink', '+ Create new customer')}
      </button>
    </>
  );
};

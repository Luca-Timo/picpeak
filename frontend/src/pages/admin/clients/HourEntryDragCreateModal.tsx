/**
 * HourEntryDragCreateModal — opens when the admin drag-selects an
 * empty time range on the admin calendar (E.7).
 *
 * Pre-filled fields from the drag:
 *   - entryDate  (the drag's start day, YYYY-MM-DD)
 *   - startTime  (HH:MM)
 *   - endTime    (HH:MM)
 *
 * Admin picks the customer through the existing CustomerPicker (C.5)
 * and optionally adds a description. Submit → POST /admin/customers/
 * :id/hour-entries (existing route from migration 129 + B.6 permission
 * split). On success, the calendar invalidates its `calendar-items`
 * query so the new entry appears as a green block.
 *
 * Per user spec: customer field is BLANK by default — no pre-fill from
 * the day's events even when there's exactly one event on that day.
 * Admin picks every time.
 *
 * The drag-create UX is gated by the existing route-layer permission:
 * the parent page already requires `customers.view`; the backend
 * enforces `customers.edit` on the POST. If the admin's role is
 * view-only, the modal opens but the submit fails with a clean 403
 * from the backend and the toast surfaces the error.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Button, Card, Input } from '../../../components/common';
import {
  CustomerPicker,
  type CustomerSummary,
} from '../../../components/admin/CustomerPicker';
import {
  customerAdminService,
  type CustomerAccountDetail,
} from '../../../services/customerAdmin.service';

export interface HourEntryDragCreateModalProps {
  /** Drag start day, YYYY-MM-DD. */
  entryDate: string;
  /** Drag start time, HH:MM. */
  startTime: string;
  /** Drag end time, HH:MM. */
  endTime: string;
  /** Close the modal without saving. */
  onClose: () => void;
  /** Called after a successful create; the page invalidates queries. */
  onCreated: () => void;
}

export const HourEntryDragCreateModal: React.FC<HourEntryDragCreateModalProps> = ({
  entryDate,
  startTime,
  endTime,
  onClose,
  onCreated,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Owned by the parent triple per the CustomerPicker contract.
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerLabel, setCustomerLabel] = useState('');
  const [customerIsPassive, setCustomerIsPassive] = useState(false);
  const [description, setDescription] = useState('');

  const createMutation = useMutation({
    mutationFn: () => {
      if (!customerId) throw new Error('Customer required');
      return customerAdminService.createHourEntry(customerId, {
        entryDate,
        startTime,
        endTime,
        description: description.trim() || null,
      });
    },
    onSuccess: () => {
      toast.success(t('calendar.hourEntry.created', 'Hours logged.'));
      // Refetch the calendar's items AND the standalone hours page if
      // it's mounted; both keys are invalidated wholesale (calendar-
      // items has a date-range tail but invalidating the prefix is
      // enough for react-query 5).
      queryClient.invalidateQueries({ queryKey: ['calendar-items'] });
      queryClient.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
      onCreated();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t('calendar.hourEntry.createFailed', { message: msg, defaultValue: `Couldn't save: ${msg}` }) as string);
    },
  });

  const canSubmit = !!customerId && !createMutation.isPending;

  // Submit handler shared by the Save button + the wrapping form's
  // implicit Enter-key submit. Wrapped in a single guard so a stale
  // press with no customer selected just no-ops instead of throwing
  // through the mutationFn.
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    createMutation.mutate();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4"
      onClick={(e) => {
        // Click on the backdrop closes; clicks inside the card stop
        // here.
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        // Esc closes — standard modal expectation. We don't trap focus
        // explicitly; the backdrop click + this Esc handler are the
        // two close paths.
        if (e.key === 'Escape' && !createMutation.isPending) onClose();
      }}
    >
      <Card padding="lg" className="w-full max-w-md">
        <h2 className="font-semibold text-lg mb-1">
          {t('calendar.hourEntry.createTitle', 'Log hours')}
        </h2>
        <p className="text-xs text-muted-theme mb-4">
          {/* The pre-filled range is part of the page state, not editable
              from this modal. Admin can edit start/end after creating
              via the inline-edit popover (also in this commit). */}
          {entryDate} · {startTime}–{endTime}
        </p>
        {/* Wrap fields in a form so pressing Enter inside the
            description input fires the submit handler — matches the
            keyboard expectation on every other admin modal. The Save
            button keeps its onClick for users who navigate via mouse. */}
        <form onSubmit={submit}>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('calendar.hourEntry.customerLabel', 'Customer')}
            </label>
            <CustomerPicker
              value={customerId}
              label={customerLabel}
              isPassive={customerIsPassive}
              // F.6 — surface the hours-logging-eligible badge so admin
              // sees up front that a customer with feature_hours_logging
              // OFF would 409 the save.
              requireFeature="hoursLogging"
              onSelect={(c: CustomerSummary) => {
                setCustomerId(c.id);
                setCustomerLabel(
                  c.companyName
                    || [c.firstName, c.lastName].filter(Boolean).join(' ')
                    || c.displayName
                    || c.email
                    || `#${c.id}`,
                );
                setCustomerIsPassive(Boolean(c.isPassive));
              }}
              onCreate={(c: CustomerAccountDetail) => {
                setCustomerId(c.id);
                setCustomerLabel(c.companyName || c.displayName || c.email || `#${c.id}`);
                setCustomerIsPassive(Boolean(c.isPassive));
              }}
              onClear={() => {
                setCustomerId(null);
                setCustomerLabel('');
                setCustomerIsPassive(false);
              }}
              searchPlaceholder={t('calendar.hourEntry.customerSearch', 'Search by email or company…') as string}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              {t('calendar.hourEntry.descriptionLabel', 'Description (optional)')}
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              placeholder={t('calendar.hourEntry.descriptionPlaceholder', 'Editing / shoot / travel…') as string}
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={createMutation.isPending}
          >
            {t('calendar.hourEntry.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            disabled={!canSubmit}
          >
            {createMutation.isPending
              ? t('calendar.hourEntry.saving', 'Saving…')
              : t('calendar.hourEntry.submit', 'Save hours')}
          </Button>
        </div>
        </form>
      </Card>
    </div>
  );
};

/**
 * "Full gallery is ready" (issue 1562).
 *
 * Completing is always a deliberate action — never "count reached" or "date
 * passed", either of which would announce an unfinished gallery. The dialog
 * says what changes for the guest, offers the "your complete gallery is
 * ready" mail (on by default), and offers to remove first-look photos that
 * arrived again in the full set under the same original filename; without
 * that the customer sees those shots twice. The badge moves onto the full-set
 * copies server-side either way.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { CheckCircle2, X } from 'lucide-react';
import { Button } from '../../../components/common';
import { eventsService, type DeliveryState } from '../../../services/events.service';
import { photosService } from '../../../services/photos.service';
import { usePermission } from '../../../hooks/usePermission';

interface CompleteDeliveryDialogProps {
  eventId: number;
  state: DeliveryState;
  isOpen: boolean;
  onClose: () => void;
  onCompleted: () => void;
}

export const CompleteDeliveryDialog: React.FC<CompleteDeliveryDialogProps> = ({ eventId, state, isOpen, onClose, onCompleted }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canDelete = usePermission('photos.delete');
  const [sendEmail, setSendEmail] = useState(true);
  const [removeDuplicates, setRemoveDuplicates] = useState(true);

  const complete = useMutation({
    mutationFn: async () => {
      const result = await eventsService.completeDelivery(eventId, { sendEmail });
      let removed = 0;
      if (removeDuplicates && canDelete && result.duplicate_photo_ids.length > 0) {
        await photosService.deletePhotos(eventId, result.duplicate_photo_ids);
        removed = result.duplicate_photo_ids.length;
      }
      return { ...result, removed };
    },
    onSuccess: (result) => {
      // Prefix keys: the event page keys its queries by the route param.
      queryClient.invalidateQueries({ queryKey: ['event-delivery', eventId] });
      queryClient.invalidateQueries({ queryKey: ['admin-event'] });
      queryClient.invalidateQueries({ queryKey: ['admin-event-photos'] });
      queryClient.invalidateQueries({ queryKey: ['admin-events'] });
      toast.success(result.email_queued
        ? t('events.delivery.completedMailed', 'The gallery is complete. The customer has been notified.')
        : t('events.delivery.completed', 'The gallery is complete.'));
      onCompleted();
      onClose();
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      toast.error(err.response?.data?.error || t('events.delivery.completeFailed', 'The gallery could not be marked as complete.'));
    },
  });

  if (!isOpen) return null;
  const guestsSee = Math.max(0, state.delivered_count - (removeDuplicates && canDelete ? state.duplicate_count : 0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="complete-delivery-title"
      onClick={(e) => { if (e.target === e.currentTarget && !complete.isPending) onClose(); }}
    >
      <div className="bg-shell rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-4">
          <h2 id="complete-delivery-title" className="text-lg font-semibold text-heading flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-accent" />
            {t('events.delivery.completeTitle', 'Mark the full gallery as ready?')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={complete.isPending}
            className="p-1 rounded hover:bg-hover-soft"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5 text-muted" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-3 text-sm text-body">
          <p>
            {t('events.delivery.completeBody', 'The banner and the placeholder tiles disappear. The first-look badges stay. Guests then see {{count}} photos.', { count: guestsSee })}
          </p>
          <label className="flex items-start gap-3 rounded-lg border border-line p-3 cursor-pointer">
            <input type="checkbox" className="mt-0.5 w-4 h-4" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
            <span>
              <span className="font-medium text-heading block">{t('events.delivery.sendMail', 'Send the "your complete gallery is ready" email')}</span>
              <span className="text-xs text-muted">
                {t('events.delivery.sendMailHelp', 'To the customer email of this gallery. Workflows can also react to "Gallery completed".')}
              </span>
            </span>
          </label>
          {state.duplicate_count > 0 && (
            <label className={`flex items-start gap-3 rounded-lg border border-line p-3 ${canDelete ? 'cursor-pointer' : 'opacity-60'}`}>
              <input
                type="checkbox"
                className="mt-0.5 w-4 h-4"
                checked={removeDuplicates && canDelete}
                disabled={!canDelete}
                onChange={(e) => setRemoveDuplicates(e.target.checked)}
              />
              <span>
                <span className="font-medium text-heading block">
                  {t('events.delivery.removeDuplicates', 'Remove {{count}} first-look duplicates', { count: state.duplicate_count })}
                </span>
                <span className="text-xs text-muted">
                  {canDelete
                    ? t('events.delivery.removeDuplicatesHelp', 'These first-look photos arrived again in the full set under the same original filename. The copies in the full set keep the badge.')
                    : t('events.delivery.removeDuplicatesNoPermission', 'Deleting photos needs the photos.delete permission.')}
                </span>
              </span>
            </label>
          )}
        </div>
        <div className="px-6 py-4 border-t border-line flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={complete.isPending}>{t('common.cancel', 'Cancel')}</Button>
          <Button variant="primary" isLoading={complete.isPending} onClick={() => complete.mutate()}>
            {sendEmail
              ? t('events.delivery.completeAndNotify', 'Mark as ready & notify')
              : t('events.delivery.completeOnly', 'Mark as ready')}
          </Button>
        </div>
      </div>
    </div>
  );
};

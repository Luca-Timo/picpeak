import React from 'react';
import { Mail, MessageCircle, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatNameList } from '../../utils/galleryRecipients';

interface GalleryRecipientsListProps {
  /** Gets the standard gallery email (link + password). */
  inlineEmail: string | null;
  /** Assigned customer accounts — get a link to their customer portal. */
  accountNames: string[];
  /** Publish also messages this number when WhatsApp is configured. */
  whatsappPhone?: string | null;
  className?: string;
}

/**
 * Who a gallery announcement reaches, one line per kind of email, so the
 * admin sees before sending that the inline address gets the gallery email and
 * the assigned accounts get their portal email. Names are shortened to the
 * first two; the full list is in the tooltip.
 */
export const GalleryRecipientsList: React.FC<GalleryRecipientsListProps> = ({ inlineEmail, accountNames, whatsappPhone, className = '' }) => {
  const { t } = useTranslation();
  if (!inlineEmail && accountNames.length === 0 && !whatsappPhone) return null;
  return (
    <ul className={`rounded-md border border-line bg-inset px-3 py-2 space-y-1.5 text-sm ${className}`}>
      {inlineEmail && (
        <li className="flex items-start gap-2">
          <Mail className="w-4 h-4 mt-0.5 shrink-0 text-soft" />
          <span className="min-w-0 break-words">
            <span className="text-soft">{t('events.recipients.galleryEmail', 'Gallery email')}:</span>{' '}
            <span className="text-heading">{inlineEmail}</span>
          </span>
        </li>
      )}
      {accountNames.length > 0 && (
        <li className="flex items-start gap-2">
          <UserRound className="w-4 h-4 mt-0.5 shrink-0 text-soft" />
          <span className="min-w-0 break-words" title={accountNames.join(', ')}>
            <span className="text-soft">{t('events.recipients.portalEmail', 'Customer portal email')}:</span>{' '}
            <span className="text-heading">{formatNameList(accountNames, t)}</span>
          </span>
        </li>
      )}
      {whatsappPhone && (
        <li className="flex items-start gap-2">
          <MessageCircle className="w-4 h-4 mt-0.5 shrink-0 text-soft" />
          <span className="min-w-0 break-words">
            <span className="text-soft">{t('events.recipients.whatsapp', 'WhatsApp')}:</span>{' '}
            <span className="text-heading">{whatsappPhone}</span>
          </span>
        </li>
      )}
    </ul>
  );
};

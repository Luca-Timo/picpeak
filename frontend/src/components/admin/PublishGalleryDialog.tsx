import React, { useState } from 'react';
import { X, Send, Lock, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input } from '../common';

interface PublishGalleryDialogProps {
  eventName: string;
  requirePassword: boolean;
  customerEmail?: string | null;
  isPublishing: boolean;
  onConfirm: (password?: string) => void;
  onClose: () => void;
}

/**
 * Confirmation dialog for the "Publish & Notify" action on a draft gallery.
 *
 * When the gallery is password-protected, the admin re-types the password
 * here so the gallery_created email can carry the real plaintext instead of
 * the "(set at creation)" sentinel (#627). The backend also re-hashes what
 * the admin types so the stored hash matches what was just emailed — admins
 * who mistype at creation get a self-healing publish flow.
 *
 * For galleries without a password, the dialog is a plain confirm + Publish
 * button (mirrors the previous window.confirm() flow).
 */
export const PublishGalleryDialog: React.FC<PublishGalleryDialogProps> = ({
  eventName,
  requirePassword,
  customerEmail,
  isPublishing,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = () => {
    if (requirePassword) {
      if (!password || password.trim().length < 6) {
        setError(t('events.publishDialog.errorMinLength', 'Password must be at least 6 characters long.'));
        return;
      }
    }
    setError(undefined);
    onConfirm(requirePassword ? password : undefined);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="max-w-md w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {t('events.publishDialog.title', 'Publish gallery')}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-neutral-600 dark:text-neutral-400 mb-4">
          {customerEmail
            ? t('events.publishDialog.descriptionWithEmail', {
                eventName,
                customerEmail,
                defaultValue:
                  'Publishing "{{eventName}}" makes the gallery accessible and sends the notification email to {{customerEmail}}.',
              })
            : t('events.publishDialog.descriptionNoEmail', {
                eventName,
                defaultValue:
                  'Publishing "{{eventName}}" makes the gallery accessible. No customer email is set, so no notification will be sent.',
              })}
        </p>

        {requirePassword && customerEmail && (
          <div className="space-y-3 mb-4">
            <Input
              type={showPassword ? 'text' : 'password'}
              label={t('events.publishDialog.passwordLabel', 'Gallery password')}
              placeholder={t('events.publishDialog.passwordPlaceholder', 'Enter the gallery password')}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(undefined);
              }}
              error={error}
              helperText={t(
                'events.publishDialog.passwordHelp',
                'Re-type the password set at creation (or pick a new one). The email includes this exact text; the backend re-hashes it so the gallery login still works.',
              )}
              leftIcon={<Lock className="w-5 h-5" />}
              rightIcon={
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="p-1"
                  aria-label={showPassword ? t('events.passwordReset.hide', 'Hide') : t('events.passwordReset.show', 'Show')}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              }
            />
          </div>
        )}

        {/* Stack both buttons vertically (always). The German primary label
            "Veröffentlichen & Kunden benachrichtigen" is ~40 chars including
            the icon — at max-w-md, no side-by-side row layout fits it on one
            line, and the base .btn class has @apply whitespace-nowrap (see
            index.css:149) which overrides a whitespace-normal className via
            CSS cascade order, so the text won't wrap either. Side-by-side
            would silently push the button past the modal frame (#670).
            col-reverse keeps the DOM order semantically secondary-then-primary
            while putting the primary action visually on top — standard
            confirmation-dialog pattern. */}
        <div className="flex flex-col-reverse gap-3">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isPublishing}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isPublishing}
            isLoading={isPublishing}
            leftIcon={<Send className="w-4 h-4" />}
          >
            {t('events.publishAndNotify')}
          </Button>
        </div>
      </Card>
    </div>
  );
};

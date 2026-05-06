/**
 * Customer accept-invite page (#354).
 *
 * Mounted at /customer/invite/:token. Public route — anyone with the
 * link can complete the invitation. The token IS the auth: 256 bits of
 * entropy, single-use, 7-day TTL, server-side validated.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Lock, User as UserIcon, AlertCircle, CheckCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { Button, Input, Card, Loading } from '../../components/common';
import { customerService, type CustomerInvitationInfo } from '../../services/customer.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';

export const CustomerAcceptInvitePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token = '' } = useParams<{ token: string }>();

  const [invitation, setInvitation] = useState<CustomerInvitationInfo | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(true);

  const [formData, setFormData] = useState({ name: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: settingsData } = usePublicSettings();
  const companyName = settingsData?.branding_company_name?.trim() || 'PicPeak';
  const logoUrl = settingsData?.branding_logo_url?.trim();
  const resolvedLogoUrl = logoUrl || '/picpeak-logo-transparent.png';

  // Pre-flight invitation lookup so the page can show "you've been invited
  // by X" / "your email will be Y" before the user fills in the form.
  useEffect(() => {
    let cancelled = false;
    setIsLookingUp(true);
    customerService.getInvitation(token)
      .then((info) => {
        if (cancelled) return;
        setInvitation(info);
      })
      .catch(() => {
        if (cancelled) return;
        setLookupError(t(
          'customer.acceptInvite.invalidToken',
          'This invitation link is invalid or has expired. Please contact your photographer for a new invitation.'
        ));
      })
      .finally(() => {
        if (!cancelled) setIsLookingUp(false);
      });
    return () => { cancelled = true; };
  }, [token, t]);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!formData.name.trim()) {
      next.name = t('customer.acceptInvite.nameRequired', 'Please enter your name');
    }
    if (formData.password.length < 8) {
      next.password = t('customer.acceptInvite.passwordTooShort', 'Password must be at least 8 characters');
    }
    if (formData.password !== formData.confirm) {
      next.confirm = t('customer.acceptInvite.passwordsMismatch', 'Passwords do not match');
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      await customerService.acceptInvitation(token, formData.name.trim(), formData.password);
      toast.success(t('customer.acceptInvite.successToast', 'Account created — please log in.'));
      // Redirect to login with a flag so the login page can show a friendly
      // confirmation. We deliberately don't auto-login because the customer
      // just typed a brand-new password and should confirm it works.
      navigate('/customer/login?accepted=1', { replace: true });
    } catch (error: any) {
      if (error.response?.status === 409) {
        setErrors({ form: t('customer.acceptInvite.alreadyExists', 'An account with this email already exists. Please log in instead.') });
      } else if (error.response?.data?.details?.length) {
        setErrors({ password: error.response.data.details.join(' ') });
      } else if (error.response?.status === 400) {
        setErrors({ form: error.response?.data?.error || t('customer.acceptInvite.invalidSubmission', 'Could not create your account.') });
      } else {
        toast.error(t('customer.acceptInvite.generalError', 'Could not create your account. Please try again.'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-8"
      style={{ backgroundColor: 'var(--color-background, #fafafa)' }}
    >
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src={resolvedLogoUrl}
            alt={companyName}
            className="h-16 w-auto object-contain mx-auto mb-4"
          />
          <h1 className="text-2xl font-bold text-theme">
            {t('customer.acceptInvite.title', 'Set up your account')}
          </h1>
        </div>

        <Card padding="lg">
          {isLookingUp ? (
            <div className="flex justify-center py-8"><Loading size="lg" /></div>
          ) : lookupError || !invitation ? (
            <div className="flex items-start gap-2 text-sm">
              <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-600" />
              <p className="text-theme">{lookupError}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-lg" style={{ backgroundColor: 'var(--color-elevated, #f5f5f5)' }}>
                <CheckCircle className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--color-accent)' }} />
                <div className="text-sm text-theme">
                  {t('customer.acceptInvite.emailWillBe', 'Your account email will be ')}
                  <span className="font-medium">{invitation.email}</span>
                  {invitation.invitedBy ? (
                    <>
                      {t('customer.acceptInvite.invitedBy', ', invited by ')}
                      <span className="font-medium">{invitation.invitedBy}</span>
                    </>
                  ) : null}
                  .
                </div>
              </div>

              {errors.form && (
                <div role="alert" className="flex items-start gap-2 p-3 rounded-lg border" style={{ borderColor: 'var(--color-surface-border)' }}>
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-600" />
                  <span className="text-sm text-theme">{errors.form}</span>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-theme mb-1">
                  {t('customer.acceptInvite.name', 'Your name')}
                </label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                  error={errors.name}
                  leftIcon={<UserIcon className="w-5 h-5 text-neutral-400" />}
                  autoComplete="name"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-theme mb-1">
                  {t('customer.acceptInvite.password', 'Choose a password')}
                </label>
                <Input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData((p) => ({ ...p, password: e.target.value }))}
                  error={errors.password}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  autoComplete="new-password"
                />
                <p className="mt-1 text-xs text-muted-theme">
                  {t('customer.acceptInvite.passwordHint', 'At least 8 characters.')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-theme mb-1">
                  {t('customer.acceptInvite.confirm', 'Confirm password')}
                </label>
                <Input
                  type="password"
                  value={formData.confirm}
                  onChange={(e) => setFormData((p) => ({ ...p, confirm: e.target.value }))}
                  error={errors.confirm}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  autoComplete="new-password"
                />
              </div>

              <Button type="submit" variant="primary" size="lg" isLoading={isSubmitting} className="w-full">
                {t('customer.acceptInvite.submit', 'Create account')}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
};

export default CustomerAcceptInvitePage;

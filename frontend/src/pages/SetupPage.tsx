import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Key, Mail, Lock, Eye, EyeOff, AlertCircle, Sparkles } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { Button, Input, Card, Loading } from '../components/common';
import { useAdminAuth } from '../contexts';
import { setupService } from '../services/setup.service';
import type { AdminUser } from '../types';

// First-run screen. Reached on a fresh instance where no admin account exists
// yet — creates the first (super_admin) account from the browser using the
// one-time setup token printed to the server logs. Once an admin exists the
// endpoints self-close and this page redirects to the login.
export const SetupPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login } = useAdminAuth();

  const { data: status, isLoading: statusLoading, isError: statusError } = useQuery({
    queryKey: ['setup-status'],
    queryFn: setupService.getSetupStatus,
    retry: false,
    staleTime: Infinity,
  });

  const [form, setForm] = useState({ token: '', email: '', password: '', confirm: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (statusLoading) {
    return <Loading fullScreen />;
  }
  // Setup already done, OR the status couldn't be read (e.g. a transient 500) →
  // go to login rather than flashing the create-admin form on a configured
  // instance. Only render the wizard when we know an admin is genuinely missing.
  if (statusError || !status?.needsAdmin) {
    return <Navigate to="/admin/login" replace />;
  }

  const setField = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: '' }));
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!form.token.trim()) next.token = t('setup.tokenRequired');
    if (!form.email) next.email = t('setup.emailRequired');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) next.email = t('setup.invalidEmail');
    if (!form.password) next.password = t('setup.passwordRequired');
    // Mirror the server's rule (validatePassword): >=8 chars with upper, lower
    // and a digit — so the user isn't bounced by the server after a green client.
    else if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(form.password)) next.password = t('setup.passwordRequirements');
    if (form.confirm !== form.password) next.confirm = t('setup.passwordMismatch');
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    toast.dismiss();
    if (!validate()) return;

    setIsSubmitting(true);
    setErrors({});
    try {
      const { user } = await setupService.createInitialAdmin({
        token: form.token.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      // Cookie is set by the backend; register the session and enter the app.
      const adminUser: AdminUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        mustChangePassword: false,
        role: { name: user.role.name, displayName: user.role.displayName ?? user.role.name },
      };
      login('', adminUser);
      toast.success(t('setup.success'));
      navigate('/admin/dashboard', { replace: true });
    } catch (error: any) {
      const httpStatus = error.response?.status;
      const data = error.response?.data;
      // Map the server's field back to a translated message instead of
      // rendering its raw English error verbatim.
      const fieldKey: Record<string, string> = {
        token: 'setup.invalidToken',
        email: 'setup.invalidEmail',
        password: 'setup.passwordRequirements',
      };
      if (httpStatus === 429) {
        toast.error(t('setup.tooManyAttempts'));
      } else if (httpStatus === 409) {
        // Someone else finished setup first — send to login.
        navigate('/admin/login', { replace: true });
      } else if (data?.field && fieldKey[data.field]) {
        setErrors({ [data.field]: t(fieldKey[data.field]) });
      } else if (Array.isArray(data?.errors) && data.errors.length) {
        const p = data.errors[0]?.path || data.errors[0]?.param;
        setErrors(p && fieldKey[p] ? { [p]: t(fieldKey[p]) } : { form: t('setup.genericError') });
      } else {
        setErrors({ form: t('setup.genericError') });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-6 rounded-2xl flex items-center justify-center" style={{ backgroundColor: '#eee6d2' }}>
            <Sparkles className="w-8 h-8" style={{ color: 'var(--color-primary, #5C8762)' }} />
          </div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--color-text, #171717)' }}>{t('setup.title')}</h1>
          <p className="mt-2" style={{ color: 'var(--color-text, #171717)', opacity: 0.7 }}>{t('setup.subtitle')}</p>
        </div>

        <Card padding="lg">
          <form onSubmit={handleSubmit} className="space-y-6">
            {errors.form && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800">{errors.form}</p>
              </div>
            )}

            <div>
              <label htmlFor="setup-token" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('setup.tokenLabel')}
              </label>
              <Input
                id="setup-token"
                type="text"
                value={form.token}
                onChange={setField('token')}
                error={errors.token}
                placeholder={t('setup.tokenPlaceholder')}
                leftIcon={<Key className="w-5 h-5 text-neutral-400" />}
                autoFocus
              />
              <p className="mt-1 text-xs text-neutral-500">{t('setup.tokenHint')}</p>
            </div>

            <div>
              <label htmlFor="setup-email" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('setup.emailLabel')}
              </label>
              <Input
                id="setup-email"
                type="email"
                value={form.email}
                onChange={setField('email')}
                error={errors.email}
                placeholder={t('setup.emailPlaceholder')}
                leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="setup-password" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('setup.passwordLabel')}
              </label>
              <div className="relative">
                <Input
                  id="setup-password"
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={setField('password')}
                  error={errors.password}
                  placeholder={t('setup.passwordPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-600 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="setup-confirm" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('setup.confirmLabel')}
              </label>
              <Input
                id="setup-confirm"
                type={showPassword ? 'text' : 'password'}
                value={form.confirm}
                onChange={setField('confirm')}
                error={errors.confirm}
                placeholder={t('setup.confirmPlaceholder')}
                leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                autoComplete="new-password"
              />
            </div>

            <Button type="submit" variant="primary" size="lg" isLoading={isSubmitting} className="w-full">
              {t('setup.submit')}
            </Button>
          </form>
        </Card>

        <p className="text-center text-xs mt-6" style={{ color: 'var(--color-text, #171717)', opacity: 0.6 }}>
          {t('setup.tokenLocationHint')}
        </p>
      </div>
    </div>
  );
};

SetupPage.displayName = 'SetupPage';

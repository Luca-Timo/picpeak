/**
 * Customer login page (#354).
 *
 * Mounted at /customer/login. Strictly separate from /admin/login —
 * different auth context, different cookie, different backend route.
 */
import React, { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Lock, Mail, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { Button, Input, Card, ReCaptcha } from '../../components/common';
import { useCustomerAuth } from '../../contexts/CustomerAuthContext';
import { customerService } from '../../services/customer.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';

export const CustomerLoginPage: React.FC = () => {
  const { t } = useTranslation();
  const { isAuthenticated, setCustomer } = useCustomerAuth();
  const [searchParams] = useSearchParams();

  const [formData, setFormData] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);

  const { data: settingsData } = usePublicSettings();
  const companyName = settingsData?.branding_company_name?.trim() || 'PicPeak';
  const logoUrl = settingsData?.branding_logo_url?.trim();
  const resolvedLogoUrl = logoUrl || '/picpeak-logo-transparent.png';

  // After /accept-invite the user is redirected here with ?accepted=1
  // so we can show a friendly success toast on first paint.
  React.useEffect(() => {
    if (searchParams.get('accepted') === '1') {
      toast.success(t('customer.login.acceptedToast', 'Account ready — please log in.'));
    }
  }, [searchParams, t]);

  if (isAuthenticated) {
    return <Navigate to="/customer/dashboard" replace />;
  }

  const validateForm = (): boolean => {
    const next: Record<string, string> = {};
    if (!formData.email) {
      next.email = t('customer.login.emailRequired', 'Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      next.email = t('customer.login.invalidEmail', 'Please enter a valid email');
    }
    if (!formData.password) {
      next.password = t('customer.login.passwordRequired', 'Password is required');
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    toast.dismiss();
    if (!validateForm()) return;

    setIsLoading(true);
    setErrors({});
    try {
      const response = await customerService.login(
        formData.email,
        formData.password,
        recaptchaToken
      );
      setCustomer(response.customer);
      toast.success(t('customer.login.loginSuccess', 'Welcome back!'));
      // Navigate via Navigate component on next render — setCustomer
      // flips isAuthenticated true so the redirect at the top fires.
    } catch (error: any) {
      if (error.response?.status === 429 || error.response?.status === 423) {
        toast.error(t('customer.login.tooManyAttempts', 'Too many attempts — please try again later.'));
      } else if (error.response?.status === 401) {
        setErrors({ form: t('customer.login.invalidCredentials', 'Invalid email or password') });
      } else if (error.code === 'ERR_NETWORK') {
        toast.error(t('customer.login.networkError', 'Could not reach the server. Please try again.'));
      } else {
        toast.error(t('customer.login.generalError', 'Login failed. Please try again.'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (field: 'email' | 'password') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      if (errors[field]) setErrors((prev) => ({ ...prev, [field]: '' }));
    };

  return (
    <div
      className="customer-surface min-h-screen flex items-center justify-center px-4 py-8"
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
            {t('customer.login.title', 'Customer login')}
          </h1>
          <p className="mt-2 text-sm text-muted-theme">
            {t('customer.login.subtitle', 'Access all of your photo galleries in one place.')}
          </p>
        </div>

        <Card padding="lg">
          <form onSubmit={handleSubmit} className="space-y-4">
            {errors.form && (
              <div
                role="alert"
                className="flex items-start gap-2 p-3 rounded-lg border"
                style={{
                  borderColor: 'var(--color-surface-border, #e5e5e5)',
                  color: 'var(--color-text)',
                  backgroundColor: 'var(--color-elevated, rgba(220, 38, 38, 0.05))',
                }}
              >
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-600" />
                <span className="text-sm">{errors.form}</span>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.login.email', 'Email')}
              </label>
              <Input
                type="email"
                value={formData.email}
                onChange={handleInputChange('email')}
                error={errors.email}
                leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
                autoComplete="email"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customer.login.password', 'Password')}
              </label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={formData.password}
                  onChange={handleInputChange('password')}
                  error={errors.password}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((p) => !p)}
                  className="absolute right-3 top-2 p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  aria-label={showPassword
                    ? t('customer.login.hidePassword', 'Hide password')
                    : t('customer.login.showPassword', 'Show password')}
                >
                  {showPassword
                    ? <EyeOff className="w-4 h-4 text-neutral-500" />
                    : <Eye className="w-4 h-4 text-neutral-500" />}
                </button>
              </div>
            </div>

            <ReCaptcha onChange={setRecaptchaToken} />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              isLoading={isLoading}
              className="w-full"
            >
              {t('customer.login.signIn', 'Sign in')}
            </Button>
          </form>
        </Card>

        <p className="text-center mt-6 text-sm text-muted-theme">
          {t(
            'customer.login.adminHint',
            'Looking for the admin panel? Visit /admin/login.'
          )}
        </p>
      </div>
    </div>
  );
};

export default CustomerLoginPage;

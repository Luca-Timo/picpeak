import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save, KeyRound, PlugZap, Copy, Check } from 'lucide-react';
import type { AxiosError } from 'axios';

import { Button, Card, Input, Loading } from '../../../components/common';
import { ssoService, SsoSettings, UpdateSsoSettings } from '../../../services/sso.service';

// SSO (OIDC) settings (#798, phase 1). Deliberately lean: issuer + client
// credentials, JIT toggle with default role, button label. Role-claim
// mapping is a follow-up. The client secret is write-only — the field stays
// blank and only overwrites when the admin types a new value.
export const SsoTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<SsoSettings | null>(null);
  const [newSecret, setNewSecret] = useState('');
  const [copied, setCopied] = useState(false);

  const { isLoading } = useQuery({
    queryKey: ['admin-sso-settings'],
    queryFn: async () => {
      const settings = await ssoService.getSettings();
      setForm((prev) => prev ?? settings);
      return settings;
    },
  });

  const saveMutation = useMutation({
    mutationFn: (data: UpdateSsoSettings) => ssoService.updateSettings(data),
    onSuccess: () => {
      toast.success(t('settings.sso.saved', 'SSO settings saved'));
      setNewSecret('');
      setForm(null); // re-init from the fresh GET (secret_set flag updates)
      queryClient.invalidateQueries({ queryKey: ['admin-sso-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    },
    onError: (error: AxiosError<{ error?: string }>) => {
      toast.error(error.response?.data?.error || t('settings.sso.saveError', 'Failed to save SSO settings'));
    },
  });

  const testMutation = useMutation({
    mutationFn: () => ssoService.testConnection(),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(t('settings.sso.testOk', 'Discovery succeeded — issuer is reachable: {{issuer}}', { issuer: result.issuer }));
      } else {
        toast.error(result.error || t('settings.sso.testFailed', 'Discovery failed'));
      }
    },
    onError: (error: AxiosError<{ error?: string }>) => {
      toast.error(error.response?.data?.error || t('settings.sso.testFailed', 'Discovery failed'));
    },
  });

  if (isLoading || !form) {
    return <Loading />;
  }

  const set = <K extends keyof SsoSettings>(key: K, value: SsoSettings[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const handleSave = () => {
    const payload: UpdateSsoSettings = {
      oidc_enabled: form.oidc_enabled,
      oidc_issuer_url: form.oidc_issuer_url.trim(),
      oidc_client_id: form.oidc_client_id.trim(),
      oidc_autoprovision: form.oidc_autoprovision,
      oidc_default_role: form.oidc_default_role,
      oidc_button_label: form.oidc_button_label.trim(),
      oidc_scopes: form.oidc_scopes.trim(),
    };
    if (newSecret.trim()) payload.oidc_client_secret = newSecret.trim();
    saveMutation.mutate(payload);
  };

  const copyRedirectUri = async () => {
    try {
      await navigator.clipboard.writeText(form.redirect_uri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the URI is visible to copy by hand.
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-neutral-500" />
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('settings.sso.title', 'Single Sign-On (OIDC)')}
            </h2>
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('settings.sso.intro', 'Let admins sign in through your identity provider (Keycloak, Authentik, Pocket ID, or any OIDC-compliant IdP). Local email/password login stays available as a fallback.')}
          </p>

          {/* Redirect URI for the IdP client registration */}
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 p-3">
            <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              {t('settings.sso.redirectUri', 'Redirect URI (register this on your IdP client)')}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100">
                {form.redirect_uri}
              </code>
              <button
                type="button"
                onClick={copyRedirectUri}
                className="flex-shrink-0 rounded-md border border-neutral-200 dark:border-neutral-600 bg-white dark:bg-neutral-700 p-2 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 transition-colors"
                aria-label={t('common.copy', 'Copy')}
                title={t('common.copy', 'Copy')}
              >
                {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <Input
            label={t('settings.sso.issuerUrl', 'Issuer URL')}
            placeholder="https://id.example.com/realms/main"
            value={form.oidc_issuer_url}
            onChange={(e) => set('oidc_issuer_url', e.target.value)}
          />
          <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            {t('settings.sso.issuerHint', 'The base URL that serves /.well-known/openid-configuration.')}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t('settings.sso.clientId', 'Client ID')}
              value={form.oidc_client_id}
              onChange={(e) => set('oidc_client_id', e.target.value)}
            />
            <div>
              <Input
                label={t('settings.sso.clientSecret', 'Client Secret')}
                type="password"
                autoComplete="new-password"
                placeholder={form.oidc_client_secret_set
                  ? t('settings.sso.secretSetPlaceholder', '•••••• (saved — type to replace)')
                  : t('settings.sso.secretUnsetPlaceholder', 'Paste the client secret')}
                value={newSecret}
                onChange={(e) => setNewSecret(e.target.value)}
              />
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.secretHint', 'Stored encrypted; never shown again. Leave blank to keep the current one.')}
              </p>
            </div>
          </div>

          <Input
            label={t('settings.sso.scopes', 'Scopes')}
            value={form.oidc_scopes}
            onChange={(e) => set('oidc_scopes', e.target.value)}
          />

          <label className="flex items-start gap-3 pt-1 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              checked={form.oidc_autoprovision}
              onChange={(e) => set('oidc_autoprovision', e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t('settings.sso.autoprovision', 'Auto-provision unknown users')}
              </span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.autoprovisionHint', 'Create an admin account on first SSO login. Off: only existing/linked admins can sign in.')}
              </span>
            </span>
          </label>

          {form.oidc_autoprovision && (
            <div className="max-w-xs">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.sso.defaultRole', 'Role for new users')}
              </label>
              <select
                value={form.oidc_default_role}
                onChange={(e) => set('oidc_default_role', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
              >
                <option value="viewer">{t('users.roles.viewer', 'Viewer')}</option>
                <option value="editor">{t('users.roles.editor', 'Editor')}</option>
                <option value="admin">{t('users.roles.admin', 'Admin')}</option>
                <option value="super_admin">{t('users.roles.super_admin', 'Super Admin')}</option>
              </select>
            </div>
          )}

          <Input
            label={t('settings.sso.buttonLabel', 'Login button label (optional)')}
            placeholder={t('settings.sso.buttonLabelPlaceholder', 'Sign in with SSO')}
            value={form.oidc_button_label}
            onChange={(e) => set('oidc_button_label', e.target.value)}
          />

          <label className="flex items-start gap-3 pt-1 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              checked={form.oidc_enabled}
              onChange={(e) => set('oidc_enabled', e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t('settings.sso.enabled', 'Enable SSO login')}
              </span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.enabledHint', 'Shows the SSO button on the admin login page. Requires issuer, client ID and secret.')}
              </span>
            </span>
          </label>

          <div className="flex items-center gap-3 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <Button
              variant="primary"
              leftIcon={<Save className="w-4 h-4" />}
              onClick={handleSave}
              isLoading={saveMutation.isPending}
            >
              {t('common.save', 'Save')}
            </Button>
            <Button
              variant="outline"
              leftIcon={<PlugZap className="w-4 h-4" />}
              onClick={() => testMutation.mutate()}
              isLoading={testMutation.isPending}
            >
              {t('settings.sso.test', 'Test connection')}
            </Button>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('settings.sso.testHint', 'Test runs OIDC discovery against the saved configuration — save first.')}
          </p>
        </div>
      </Card>
    </div>
  );
};

SsoTab.displayName = 'SsoTab';

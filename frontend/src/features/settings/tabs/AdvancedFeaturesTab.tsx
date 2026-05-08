/**
 * Settings → Advanced features tab (#354 follow-up).
 *
 * Per the discussion in #354 — picpeak ships as a focused gallery
 * delivery tool by default. Advanced functionality (currently the
 * Customer portal — recurring customer logins, dashboard, profile,
 * password reset, admin Customers management) is opt-in here.
 *
 * Architecture:
 *   - One master toggle per advanced feature, persisted via the new
 *     PUT /api/admin/settings/advanced-features endpoint.
 *   - When a feature is ON, its sub-settings (branding visibility,
 *     per-feature flags) render inline below the master toggle by
 *     reusing the existing settings tab component. One Settings tab
 *     for the entire feature configuration — the matching admin
 *     sidebar entry (e.g. "Customers") is what's used to actually
 *     run the feature day-to-day.
 *   - When a feature is OFF, only the master row renders. The backend
 *     gates the corresponding API surface so disabling here is a real
 *     kill-switch, not just a UI hide.
 *
 * Future advanced features (booking, quotes, bills, reminder emails)
 * land as additional rows on this same page once the maintainer
 * confirms scope.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Save, Users, Beaker } from 'lucide-react';
import { Card, Button, Loading } from '../../../components/common';
import { api } from '../../../config/api';
import { CustomerSurfaceTab } from './CustomerSurfaceTab';

interface AdvancedFeaturesSettings {
  customer_portal_enabled: boolean;
}

const DEFAULTS: AdvancedFeaturesSettings = {
  customer_portal_enabled: false,
};

function parseBool(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function withDefaults(raw: Partial<Record<keyof AdvancedFeaturesSettings, unknown>> | null | undefined): AdvancedFeaturesSettings {
  return {
    customer_portal_enabled: parseBool(raw?.customer_portal_enabled) === true,
  };
}

const Toggle: React.FC<{
  enabled: boolean;
  onChange: () => void;
}> = ({ enabled, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    onClick={onChange}
    className="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
    style={{ backgroundColor: enabled ? 'var(--color-accent)' : 'var(--color-surface-border)' }}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
    />
  </button>
);

export const AdvancedFeaturesTab: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings-advanced-features'],
    queryFn: async () => {
      const res = await api.get<Partial<Record<keyof AdvancedFeaturesSettings, unknown>>>('/admin/settings/advanced-features');
      return withDefaults(res.data);
    },
  });

  const [form, setForm] = useState<AdvancedFeaturesSettings>(DEFAULTS);

  // One-shot hydration — same pattern as CustomerSurfaceTab. React Query
  // refetches on focus/reconnect; without the ref guard a refetch would
  // overwrite an unsaved toggle, making the UI feel "sticky".
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (data && !hydratedRef.current) {
      setForm(data);
      hydratedRef.current = true;
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => api.put('/admin/settings/advanced-features', form),
    onSuccess: () => {
      hydratedRef.current = false;
      qc.invalidateQueries({ queryKey: ['admin-settings-advanced-features'] });
      // public-settings carries customer_portal_enabled — invalidate so
      // AdminSidebar + customer-surface route guards re-evaluate within
      // the standard react-query staleTime.
      qc.invalidateQueries({ queryKey: ['public-settings'] });
      toast.success(t('settings.advancedFeatures.saved', 'Advanced features settings saved'));
    },
    onError: () => toast.error(t('settings.advancedFeatures.error', 'Could not save settings')),
  });

  const toggle = (key: keyof AdvancedFeaturesSettings) => {
    setForm((p) => ({ ...p, [key]: !p[key] }));
  };

  if (isLoading) {
    return <div className="py-12 flex justify-center"><Loading size="md" /></div>;
  }

  return (
    <div className="space-y-6">
      <Card padding="md">
        <div className="flex items-start gap-3 mb-2">
          <Beaker className="w-5 h-5 mt-0.5 text-muted-theme flex-shrink-0" />
          <div>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('settings.advancedFeatures.title', 'Advanced features')}
            </h2>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
              {t(
                'settings.advancedFeatures.intro',
                'Opt in to advanced functionality. Most users only need the gallery delivery features that come pre-enabled — flip these on only when your workflow actually needs them.'
              )}
            </p>
          </div>
        </div>
      </Card>

      {/* Customer portal master row */}
      <Card padding="md">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <Users className="w-5 h-5 mt-0.5 text-muted-theme flex-shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('settings.advancedFeatures.customerPortal.title', 'Customer portal')}
                </h3>
                <span
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                  title={t('settings.advancedFeatures.betaTooltip', 'Beta — feature is functional but still evolving')}
                >
                  {t('settings.advancedFeatures.beta', 'Beta')}
                </span>
              </div>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                {t(
                  'settings.advancedFeatures.customerPortal.description',
                  'Persistent customer logins so recurring clients see all their galleries from a single dashboard. Adds /customer/* URLs, a profile page, password reset, and an admin Customers management page.'
                )}
              </p>
            </div>
          </div>
          <Toggle
            enabled={form.customer_portal_enabled}
            onChange={() => toggle('customer_portal_enabled')}
          />
        </div>
      </Card>

      <div className="flex justify-end">
        <Button
          variant="primary"
          leftIcon={<Save className="w-4 h-4" />}
          isLoading={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {t('settings.advancedFeatures.save', 'Save changes')}
        </Button>
      </div>

      {/* Nested customer-portal sub-settings — render inline only when
          the master toggle is ON. Reuses CustomerSurfaceTab; its own
          save flow handles persistence. The "Customers" entry in the
          main admin sidebar (separate from Settings) is what admins use
          to actually manage customer accounts day-to-day; this nested
          block is config only. */}
      {form.customer_portal_enabled && (
        <>
          <div
            className="border-t pt-6 mt-2"
            style={{ borderColor: 'var(--color-surface-border, #e5e5e5)' }}
          >
            <h3 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">
              {t('settings.advancedFeatures.customerPortal.subSettings', 'Customer portal settings')}
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
              {t(
                'settings.advancedFeatures.customerPortal.subSettingsHint',
                'Branding visibility and per-feature toggles for the customer dashboard. Manage actual customer accounts from the "Customers" entry in the main sidebar.'
              )}
            </p>
          </div>
          <CustomerSurfaceTab />
        </>
      )}
    </div>
  );
};

export default AdvancedFeaturesTab;

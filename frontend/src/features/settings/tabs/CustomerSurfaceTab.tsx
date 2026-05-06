/**
 * Settings → Customer Surface tab (#354 follow-up).
 *
 * Two groups of toggles:
 *
 *   1. Branding visibility — hide the brand logo and/or company name from
 *      the customer sidebar header (e.g. when the maintainer's CI is
 *      already very text-heavy and the duplicate name feels noisy).
 *
 *   2. Feature globals — turn the Calendar / Quotes / Bills tabs on or
 *      off across the whole instance. The customer sees a tab iff the
 *      global toggle is ON AND their per-customer flag is ON, so flipping
 *      a global off here hides the tab for every customer immediately,
 *      regardless of per-customer state.
 *
 * Data flow: this tab queries the existing GET /admin/settings/customer-surface
 * endpoint (returns whatever rows have setting_type='customer_surface') and
 * persists via the new PUT /admin/settings/customer-surface. Kept separate
 * from the central useSettingsState() to avoid threading five more booleans
 * through the already-busy useSettingsState shape.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Save, Image as ImageIcon, Type, Calendar, FileText, Receipt } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { api } from '../../../config/api';

interface CustomerSurfaceSettings {
  customer_show_logo: boolean;
  customer_show_company_name: boolean;
  customer_feature_calendar_enabled: boolean;
  customer_feature_quotes_enabled: boolean;
  customer_feature_bills_enabled: boolean;
}

const DEFAULTS: CustomerSurfaceSettings = {
  customer_show_logo: true,
  customer_show_company_name: true,
  customer_feature_calendar_enabled: false,
  customer_feature_quotes_enabled: false,
  customer_feature_bills_enabled: false,
};

/**
 * The settings rows arrive as `{[key]: value | null}`. Keys not yet seeded
 * in the DB come back as undefined — coerce to defaults so a fresh install
 * shows the same UI as an existing one.
 */
function withDefaults(raw: Partial<CustomerSurfaceSettings> | null | undefined): CustomerSurfaceSettings {
  return {
    customer_show_logo: raw?.customer_show_logo !== false,
    customer_show_company_name: raw?.customer_show_company_name !== false,
    customer_feature_calendar_enabled: raw?.customer_feature_calendar_enabled === true,
    customer_feature_quotes_enabled: raw?.customer_feature_quotes_enabled === true,
    customer_feature_bills_enabled: raw?.customer_feature_bills_enabled === true,
  };
}

const Toggle: React.FC<{
  enabled: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
}> = ({ enabled, onChange, label, hint, icon: Icon }) => (
  <label className="flex items-start justify-between gap-4 py-3 cursor-pointer">
    <div className="flex items-start gap-3 min-w-0">
      <Icon className="w-5 h-5 mt-0.5 text-muted-theme flex-shrink-0" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-theme">{label}</div>
        {hint && <p className="text-xs text-muted-theme mt-0.5">{hint}</p>}
      </div>
    </div>
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
  </label>
);

export const CustomerSurfaceTab: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings-customer-surface'],
    queryFn: async () => {
      const res = await api.get<Partial<CustomerSurfaceSettings>>('/admin/settings/customer-surface');
      return withDefaults(res.data);
    },
  });

  const [form, setForm] = useState<CustomerSurfaceSettings>(DEFAULTS);
  useEffect(() => { if (data) setForm(data); }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => api.put('/admin/settings/customer-surface', form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings-customer-surface'] });
      // Public settings cache also needs to clear so the customer
      // sidebar picks up branding changes on its next render.
      qc.invalidateQueries({ queryKey: ['public-settings'] });
      toast.success(t('settings.customerSurface.saved', 'Customer surface settings saved'));
    },
    onError: () => toast.error(t('settings.customerSurface.error', 'Could not save settings')),
  });

  const toggle = (key: keyof CustomerSurfaceSettings) => {
    setForm((p) => ({ ...p, [key]: !p[key] }));
  };

  if (isLoading) {
    return <div className="py-12 flex justify-center"><Loading size="md" /></div>;
  }

  return (
    <div className="space-y-6">
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
          {t('settings.customerSurface.brandingTitle', 'Customer surface branding')}
        </h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
          {t(
            'settings.customerSurface.brandingHint',
            'Controls what shows in the header of the customer dashboard at /customer/dashboard. Leaves the public gallery and admin surfaces untouched.'
          )}
        </p>

        <div className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
          <Toggle
            enabled={form.customer_show_logo}
            onChange={() => toggle('customer_show_logo')}
            label={t('settings.customerSurface.showLogo', 'Show logo in customer header')}
            hint={t('settings.customerSurface.showLogoHint', 'Uses the same branding logo configured in Branding settings.')}
            icon={ImageIcon}
          />
          <Toggle
            enabled={form.customer_show_company_name}
            onChange={() => toggle('customer_show_company_name')}
            label={t('settings.customerSurface.showCompanyName', 'Show company name in customer header')}
            hint={t('settings.customerSurface.showCompanyNameHint', 'Hide if your logo already includes the company name.')}
            icon={Type}
          />
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
          {t('settings.customerSurface.featuresTitle', 'Customer features')}
        </h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
          {t(
            'settings.customerSurface.featuresHint',
            'These are the master switches for the Calendar, Quotes and Bills tabs on the customer surface. ON shows the tab for every customer by default; you can hide it for individual customers from their detail page. OFF here hides the tab for everyone, regardless of per-customer overrides. The pages themselves are still placeholders right now.'
          )}
        </p>

        <div className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
          <Toggle
            enabled={form.customer_feature_calendar_enabled}
            onChange={() => toggle('customer_feature_calendar_enabled')}
            label={t('settings.customerSurface.calendar', 'Calendar')}
            icon={Calendar}
          />
          <Toggle
            enabled={form.customer_feature_quotes_enabled}
            onChange={() => toggle('customer_feature_quotes_enabled')}
            label={t('settings.customerSurface.quotes', 'Quotes')}
            icon={FileText}
          />
          <Toggle
            enabled={form.customer_feature_bills_enabled}
            onChange={() => toggle('customer_feature_bills_enabled')}
            label={t('settings.customerSurface.bills', 'Bills')}
            icon={Receipt}
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
          {t('settings.customerSurface.save', 'Save changes')}
        </Button>
      </div>
    </div>
  );
};

export default CustomerSurfaceTab;

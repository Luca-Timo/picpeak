/**
 * Branding-aware shell for the customer dashboard surface (#354).
 *
 * Header is intentionally simple — no admin nav, no event-level chrome.
 * Just the company logo + the customer's name + a Logout button. Designed
 * to be visually consistent with the Branding palette so an admin who
 * matches Branding tokens to their CI gets the same look in the customer
 * portal as in the gallery itself.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/common';
import { useCustomerAuth } from '../../contexts/CustomerAuthContext';
import { usePublicSettings } from '../../hooks/usePublicSettings';

interface CustomerLayoutProps {
  children: React.ReactNode;
}

export const CustomerLayout: React.FC<CustomerLayoutProps> = ({ children }) => {
  const { t } = useTranslation();
  const { customer, logout } = useCustomerAuth();
  const { data: settingsData } = usePublicSettings();

  const companyName = settingsData?.branding_company_name?.trim() || 'PicPeak';
  const logoUrl = settingsData?.branding_logo_url?.trim();
  const resolvedLogoUrl = logoUrl || '/picpeak-logo-transparent.png';

  const greetingName = customer?.displayName
    || customer?.firstName
    || (customer?.email ? customer.email.split('@')[0] : '');

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: 'var(--color-background, #fafafa)' }}
    >
      <header
        className="sticky top-0 z-40 border-b"
        style={{
          backgroundColor: 'var(--color-surface, #ffffff)',
          borderColor: 'var(--color-surface-border, #e5e5e5)',
        }}
      >
        <div className="container py-3 flex items-center justify-between gap-3">
          <Link
            to="/customer/dashboard"
            className="flex items-center gap-3 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 rounded"
          >
            <img
              src={resolvedLogoUrl}
              alt={companyName}
              className="h-8 w-auto object-contain"
            />
            <span className="hidden sm:inline text-base font-semibold text-theme truncate">
              {companyName}
            </span>
          </Link>

          <div className="flex items-center gap-3 min-w-0">
            {greetingName && (
              <span className="hidden sm:inline text-sm text-muted-theme truncate">
                {t('customer.layout.greeting', 'Hi, {{name}}', { name: greetingName })}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<LogOut className="w-4 h-4" />}
              onClick={() => { void logout(); }}
            >
              <span className="hidden sm:inline">{t('common.logout', 'Logout')}</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer
        className="py-6 text-center text-xs"
        style={{ color: 'var(--color-muted-text, #737373)' }}
      >
        <p>
          {settingsData?.branding_footer_text
            || `© ${new Date().getFullYear()} ${companyName}. All rights reserved.`}
        </p>
      </footer>
    </div>
  );
};

export default CustomerLayout;

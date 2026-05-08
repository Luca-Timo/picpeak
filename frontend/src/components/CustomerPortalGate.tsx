/**
 * Frontend gate for the Customer portal advanced feature (#354 follow-up).
 *
 * Wraps the /customer/* route tree. When `customer_portal_enabled` is
 * OFF in public-settings, redirect every visitor to /admin/login. The
 * backend already returns 410 Gone on the customer API surface — this
 * frontend gate just prevents the SPA from rendering the customer
 * pages and showing a confusing "feature disabled" toast at every
 * route.
 *
 * While public-settings are loading, render `null` so we don't briefly
 * flash either the customer surface or a redirect — usePublicSettings
 * is fast and cached after first load.
 */
import React from 'react';
import { Navigate } from 'react-router-dom';
import { usePublicSettings } from '../hooks/usePublicSettings';

interface CustomerPortalGateProps {
  children: React.ReactNode;
}

export const CustomerPortalGate: React.FC<CustomerPortalGateProps> = ({ children }) => {
  const { data: publicSettings, isLoading } = usePublicSettings();

  if (isLoading) return null;
  if (!publicSettings?.customer_portal_enabled) {
    return <Navigate to="/admin/login" replace />;
  }

  return <>{children}</>;
};

export default CustomerPortalGate;

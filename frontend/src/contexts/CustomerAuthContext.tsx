/**
 * Customer-side React auth context (#354).
 *
 * Sibling of AdminAuthContext / GalleryAuthContext but operates on a
 * separate cookie (customer_token) and a separate API surface
 * (/api/customer/auth/*). The contexts are isolated by design so that
 * a single browser can hold an admin session AND a customer session
 * without one clobbering the other (e.g. for the admin dogfooding the
 * customer dashboard).
 */
import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { customerService, type CustomerProfile } from '../services/customer.service';

interface CustomerAuthContextType {
  isAuthenticated: boolean;
  customer: CustomerProfile | null;
  isLoading: boolean;
  error: string | null;
  /** Replaces the cached profile after a successful POST /login. */
  setCustomer: (c: CustomerProfile) => void;
  logout: () => Promise<void>;
}

const CustomerAuthContext = createContext<CustomerAuthContextType | undefined>(undefined);

export const useCustomerAuth = () => {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) {
    throw new Error('useCustomerAuth must be used within a CustomerAuthProvider');
  }
  return ctx;
};

const STORAGE_KEY = 'customer_profile';

interface ProviderProps { children: ReactNode; }

export const CustomerAuthProvider: React.FC<ProviderProps> = ({ children }) => {
  const [customer, setCustomerState] = useState<CustomerProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Reserved for future surface-level errors (login form errors are
  // handled inline on the login page itself, not here).
  const [error] = useState<string | null>(null);

  useEffect(() => {
    // Hydrate immediately from sessionStorage so the dashboard avoids
    // a flicker on hard refresh; the network call below confirms the
    // cookie is still valid and overwrites stale data.
    try {
      const cached = sessionStorage.getItem(STORAGE_KEY);
      if (cached) setCustomerState(JSON.parse(cached));
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }

    let cancelled = false;
    customerService.session().then((response) => {
      if (cancelled) return;
      if (response?.customer) {
        setCustomerState(response.customer);
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(response.customer));
      } else {
        setCustomerState(null);
        sessionStorage.removeItem(STORAGE_KEY);
      }
      setIsLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setCustomerState(null);
      sessionStorage.removeItem(STORAGE_KEY);
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const setCustomer = (c: CustomerProfile) => {
    setCustomerState(c);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  };

  const logout = async () => {
    await customerService.logout();
    setCustomerState(null);
    sessionStorage.removeItem(STORAGE_KEY);
    // Hard navigate so any in-flight requests with the old cookie don't
    // race the cleared session — same approach AdminAuthContext uses.
    window.location.href = '/customer/login';
  };

  return (
    <CustomerAuthContext.Provider
      value={{
        isAuthenticated: !!customer,
        customer,
        isLoading,
        error,
        setCustomer,
        logout,
      }}
    >
      {children}
    </CustomerAuthContext.Provider>
  );
};

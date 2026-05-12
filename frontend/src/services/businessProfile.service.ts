/**
 * Admin → Business profile API client.
 *
 * Backs the Settings → Business profile tab. Issuer block + bank account
 * roster used to render every quote / invoice PDF.
 */
import { api } from '../config/api';

export type QrFormat = 'swiss' | 'epc' | 'none';

export interface BusinessProfile {
  id: number;
  companyName: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  state: string;
  countryCode: string;
  phone: string;
  mobile: string;
  email: string;
  website: string;
  vatId: string;
  vatLabel: string;
  vatRateDefault: number | null;
  defaultCurrency: string;
  defaultLocale: string;
  defaultQrFormat: QrFormat;
  footerLine: string;
  logoPath: string;
  /** Path (absolute or relative to storage/) to a TTF/OTF used by the
   *  PDF renderer. Falls back to Helvetica when blank or missing. */
  pdfFontTtfPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface BankAccount {
  id: number;
  label: string;
  accountHolder: string;
  iban: string;
  bic: string;
  currency: string;
  isDefault: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessProfileSnapshot {
  profile: BusinessProfile;
  bankAccounts: BankAccount[];
}

export type BusinessProfilePatch = Partial<Omit<BusinessProfile, 'id' | 'createdAt' | 'updatedAt'>>;
export type BankAccountPatch = Partial<Omit<BankAccount, 'id' | 'createdAt' | 'updatedAt'>>;

export const businessProfileService = {
  async get(): Promise<BusinessProfileSnapshot> {
    const { data } = await api.get('/admin/business-profile');
    return data.data || data;
  },

  async update(payload: BusinessProfilePatch): Promise<BusinessProfileSnapshot> {
    const { data } = await api.put('/admin/business-profile', payload);
    return data.data || data;
  },

  async listBankAccounts(): Promise<{ bankAccounts: BankAccount[] }> {
    const { data } = await api.get('/admin/business-profile/bank-accounts');
    return data.data || data;
  },

  async createBankAccount(payload: BankAccountPatch & { iban: string }): Promise<{ bankAccount: BankAccount }> {
    const { data } = await api.post('/admin/business-profile/bank-accounts', payload);
    return data.data || data;
  },

  async updateBankAccount(id: number, payload: BankAccountPatch): Promise<{ bankAccount: BankAccount }> {
    const { data } = await api.put(`/admin/business-profile/bank-accounts/${id}`, payload);
    return data.data || data;
  },

  async deleteBankAccount(id: number): Promise<{ deleted: true }> {
    const { data } = await api.delete(`/admin/business-profile/bank-accounts/${id}`);
    return data.data || data;
  },
};

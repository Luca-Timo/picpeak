/**
 * Public payment-check API client — no auth header. The token in
 * the URL is the only credential.
 */
import { api } from '../config/api';

export type PaymentCheckAction = 'paid_full' | 'partial' | 'unpaid';

export interface PaymentCheckView {
  invoiceNumber: string;
  customer: { label: string; email?: string };
  issueDate: string;
  dueDate: string;
  totalMinor: number;
  paidMinor: number;
  lateFeeMinor: number;
  outstandingMinor: number;
  currency: string;
  status: string;
  reminderLevel: number;
  expiresAt: string;
}

export interface PaymentCheckIssuer {
  companyName: string;
  email?: string;
  website?: string;
  logoUrl: string | null;
}
export interface PaymentCheckResponse {
  invoice: PaymentCheckView;
  issuer: PaymentCheckIssuer | null;
}

export const paymentCheckService = {
  async get(token: string): Promise<PaymentCheckResponse> {
    const { data } = await api.get(`/public/payment-check/${token}`);
    const body = data.data || data;
    return { invoice: body.invoice, issuer: body.issuer || null };
  },

  async record(token: string, payload: {
    action: PaymentCheckAction;
    amountMinor?: number;
  }): Promise<{ applied: PaymentCheckAction; reminderLevel?: number; reminderSkipped?: string }> {
    const { data } = await api.post(`/public/payment-check/${token}`, payload);
    return data.data || data;
  },
};

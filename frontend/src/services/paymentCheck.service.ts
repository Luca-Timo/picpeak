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

export const paymentCheckService = {
  async get(token: string): Promise<PaymentCheckView> {
    const { data } = await api.get(`/public/payment-check/${token}`);
    return (data.data || data).invoice;
  },

  async record(token: string, payload: {
    action: PaymentCheckAction;
    amountMinor?: number;
  }): Promise<{ applied: PaymentCheckAction; reminderLevel?: number; reminderSkipped?: string }> {
    const { data } = await api.post(`/public/payment-check/${token}`, payload);
    return data.data || data;
  },
};

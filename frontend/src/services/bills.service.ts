/**
 * Admin → Invoices API client. Hits /api/admin/invoices/*.
 */
import { api } from '../config/api';
import type { QuoteLineItem } from './quotes.service';

export type InvoiceStatus = 'scheduled' | 'sent' | 'paid' | 'overdue' | 'cancelled';
export type InvoiceSort =
  | 'newest' | 'oldest'
  | 'due_asc' | 'due_desc'
  | 'value_asc' | 'value_desc'
  | 'customer_asc';

export type InvoiceQrFormat = 'swiss' | 'epc' | 'none';

export interface InvoiceSummary {
  id: number;
  invoiceNumber: string;
  customerAccountId: number;
  customer: {
    email: string | null;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  };
  sourceQuoteId: number | null;
  eventId: number | null;
  language: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  installmentIndex: number;
  installmentTotal: number;
  installmentLabel: string | null;
  installmentTrigger: string | null;
  status: InvoiceStatus;
  scheduledSendAt: string | null;
  sentAt: string | null;
  totalAmountMinor: number;
  paidAmountMinor: number;
  reminderLevel: number;
  lateFeeAmountMinor: number;
}

export interface InvoiceDetail extends InvoiceSummary {
  netAmountMinor: number;
  vatRate: number | null;
  vatAmountMinor: number;
  shippingAmountMinor: number;
  paidAt: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  lastReminderSentAt: string | null;
  ccPdfEmail: string | null;
  qrFormat: InvoiceQrFormat | null;
  pdfPath: string | null;
  businessBankAccountId: number | null;
}

export interface InvoicePayment {
  id: number;
  amountMinor: number;
  paidAt: string;
  paymentMethod: string | null;
  reference: string | null;
  notes: string | null;
  createdAt: string;
}

export interface InvoiceWithLineItems {
  invoice: InvoiceDetail;
  lineItems: QuoteLineItem[];
  payments: InvoicePayment[];
}

export interface InvoiceCreatePayload {
  customerAccountId: number;
  sourceQuoteId?: number;
  eventId?: number;
  language?: string;
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  scheduledSendAt?: string;
  installmentIndex?: number;
  installmentTotal?: number;
  installmentLabel?: string;
  installmentTrigger?: string;
  vatRate?: number;
  shippingAmountMinor?: number;
  ccPdfEmail?: string;
  businessBankAccountId?: number;
  qrFormat?: InvoiceQrFormat;
  lineItems: QuoteLineItem[];
}

export interface InvoiceListResponse {
  invoices: InvoiceSummary[];
  pagination: { total: number; page: number; pageSize: number; totalPages: number };
}

export const billsService = {
  async list(params: {
    status?: InvoiceStatus[];
    customerAccountId?: number;
    sourceQuoteId?: number;
    unpaidOnly?: boolean;
    q?: string;
    sort?: InvoiceSort;
    page?: number;
    pageSize?: number;
  } = {}): Promise<InvoiceListResponse> {
    const { data } = await api.get('/admin/invoices', {
      params: {
        ...params,
        status: params.status?.join(','),
      },
    });
    return data.data || data;
  },

  async get(id: number): Promise<InvoiceWithLineItems> {
    const { data } = await api.get(`/admin/invoices/${id}`);
    return data.data || data;
  },

  async create(payload: InvoiceCreatePayload): Promise<InvoiceWithLineItems> {
    const { data } = await api.post('/admin/invoices', payload);
    return data.data || data;
  },

  async update(id: number, payload: Partial<InvoiceCreatePayload>): Promise<InvoiceWithLineItems> {
    const { data } = await api.put(`/admin/invoices/${id}`, payload);
    return data.data || data;
  },

  async send(id: number): Promise<{ sent: true }> {
    const { data } = await api.post(`/admin/invoices/${id}/send`);
    return data.data || data;
  },

  async markPaid(id: number, payload: {
    amountMinor: number;
    paidAt?: string;
    paymentMethod?: string;
    reference?: string;
    notes?: string;
  }): Promise<{ paidTotalMinor: number; status: InvoiceStatus }> {
    const { data } = await api.post(`/admin/invoices/${id}/mark-paid`, payload);
    return data.data || data;
  },

  async sendReminder(id: number, level?: 1 | 2): Promise<{ level: number; lateFeeMinor: number }> {
    const { data } = await api.post(`/admin/invoices/${id}/send-reminder`, { level });
    return data.data || data;
  },

  async cancel(id: number): Promise<{ cancelled: true }> {
    const { data } = await api.post(`/admin/invoices/${id}/cancel`);
    return data.data || data;
  },

  async pdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/invoices/${id}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async previewPdfUrl(payload: InvoiceCreatePayload): Promise<string> {
    const res = await api.post('/admin/invoices/preview', payload, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },
};

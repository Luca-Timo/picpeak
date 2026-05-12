/**
 * Admin → Quotes API client. Hits /api/admin/quotes/* (admin auth) and
 * /api/public/quotes/:token for the customer-facing accept/decline page.
 */
import { api } from '../config/api';

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';
export type QuoteSort = 'newest' | 'oldest' | 'customer_asc' | 'value_asc' | 'value_desc';

export interface QuoteLineItem {
  id?: number;
  position: number;
  quantity: number;
  description: string;
  unitPriceMinor: number;
  discountPercent: number;
  lineTotalMinor?: number;
}

export interface QuoteSummary {
  id: number;
  quoteNumber: string;
  customerAccountId: number;
  customer: {
    email: string | null;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  };
  status: QuoteStatus;
  language: string;
  currency: string;
  issueDate: string;
  validUntil: string | null;
  eventName: string | null;
  eventDate: string | null;
  totalAmountMinor: number;
  sentAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  convertedEventId: number | null;
  createdAt: string;
}

export interface QuoteDetail extends QuoteSummary {
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  expectedDurationHours: number | null;
  paymentTermTemplateId: number | null;
  netAmountMinor: number;
  vatRate: number | null;
  vatAmountMinor: number;
  shippingAmountMinor: number;
  introText: string | null;
  outroText: string | null;
  internalNotes: string | null;
  ccPdfEmail: string | null;
  respondedAt: string | null;
  responseLockedAt: string | null;
  pdfPath: string | null;
  businessBankAccountId: number | null;
}

export interface QuoteWithLineItems {
  quote: QuoteDetail;
  lineItems: QuoteLineItem[];
}

export interface PaymentTermInstallment {
  label: string;
  percent: number;
  trigger: 'quote_accepted' | 'before_event' | 'after_event' | 'after_delivery' | 'fixed_date';
  offset_days: number;
}

export interface PaymentTermTemplate {
  id: number;
  name: string;
  description: string;
  netDays: number;
  skontoPercent: number | null;
  skontoWithinDays: number | null;
  installments: PaymentTermInstallment[];
  isSystem: boolean;
  isActive: boolean;
  displayOrder: number;
}

export interface LineItemPreset {
  id: number;
  name: string;
  description: string;
  unitPriceMinor: number;
  currency: string;
  quantityDefault: number;
  displayOrder: number;
  isActive: boolean;
}

export interface QuoteCreatePayload {
  customerAccountId: number;
  language?: string;
  currency?: string;
  issueDate?: string;
  validUntil?: string;
  eventName?: string;
  eventDate?: string;
  eventTimeStart?: string;
  eventTimeEnd?: string;
  expectedDurationHours?: number;
  paymentTermTemplateId?: number;
  vatRate?: number;
  shippingAmountMinor?: number;
  introText?: string;
  outroText?: string;
  internalNotes?: string;
  ccPdfEmail?: string;
  businessBankAccountId?: number;
  lineItems: QuoteLineItem[];
}

export interface QuoteListResponse {
  quotes: QuoteSummary[];
  pagination: { total: number; page: number; pageSize: number; totalPages: number };
}

export const quotesService = {
  async list(params: {
    status?: QuoteStatus[];
    customerAccountId?: number;
    q?: string;
    from?: string;
    to?: string;
    sort?: QuoteSort;
    page?: number;
    pageSize?: number;
  } = {}): Promise<QuoteListResponse> {
    const { data } = await api.get('/admin/quotes', {
      params: {
        ...params,
        status: params.status?.join(','),
      },
    });
    return data.data || data;
  },

  async get(id: number): Promise<QuoteWithLineItems> {
    const { data } = await api.get(`/admin/quotes/${id}`);
    return data.data || data;
  },

  async create(payload: QuoteCreatePayload): Promise<QuoteWithLineItems> {
    const { data } = await api.post('/admin/quotes', payload);
    return data.data || data;
  },

  async update(id: number, payload: Partial<QuoteCreatePayload>): Promise<QuoteWithLineItems> {
    const { data } = await api.put(`/admin/quotes/${id}`, payload);
    return data.data || data;
  },

  async send(id: number): Promise<{ sent: true; token: string }> {
    const { data } = await api.post(`/admin/quotes/${id}/send`);
    return data.data || data;
  },

  async duplicate(id: number): Promise<{ id: number }> {
    const { data } = await api.post(`/admin/quotes/${id}/duplicate`);
    return data.data || data;
  },

  async convert(id: number): Promise<{ eventId: number; alreadyConverted: boolean }> {
    const { data } = await api.post(`/admin/quotes/${id}/convert`);
    return data.data || data;
  },

  /** Returns a blob URL the editor can `window.open()` straight into a tab. */
  async pdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/quotes/${id}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async previewPdfUrl(payload: QuoteCreatePayload): Promise<string> {
    const res = await api.post('/admin/quotes/preview', payload, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async listLineItemPresets(): Promise<{ presets: LineItemPreset[] }> {
    const { data } = await api.get('/admin/quotes/presets/line-items');
    return data.data || data;
  },

  async createLineItemPreset(payload: Partial<LineItemPreset> & { name: string }): Promise<{ preset: LineItemPreset }> {
    const { data } = await api.post('/admin/quotes/presets/line-items', payload);
    return data.data || data;
  },

  async listPaymentTermTemplates(): Promise<{ templates: PaymentTermTemplate[] }> {
    const { data } = await api.get('/admin/quotes/presets/payment-terms');
    return data.data || data;
  },

  async createPaymentTermTemplate(payload: Omit<PaymentTermTemplate, 'id' | 'isSystem'>): Promise<{ template: PaymentTermTemplate }> {
    const { data } = await api.post('/admin/quotes/presets/payment-terms', payload);
    return data.data || data;
  },

  async updatePaymentTermTemplate(id: number, payload: Partial<PaymentTermTemplate>): Promise<{ template: PaymentTermTemplate }> {
    const { data } = await api.put(`/admin/quotes/presets/payment-terms/${id}`, payload);
    return data.data || data;
  },

  async deletePaymentTermTemplate(id: number): Promise<{ deleted: true }> {
    const { data } = await api.delete(`/admin/quotes/presets/payment-terms/${id}`);
    return data.data || data;
  },
};

// -------------------------------------------------------------------
// Public (no-auth) — accept / decline page
// -------------------------------------------------------------------

export interface PublicQuoteView {
  quoteNumber: string;
  status: QuoteStatus;
  language: string;
  currency: string;
  issueDate: string;
  validUntil: string | null;
  eventName: string | null;
  eventDate: string | null;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  introText: string | null;
  outroText: string | null;
  netAmountMinor: number;
  vatRate: number | null;
  vatAmountMinor: number;
  shippingAmountMinor: number;
  totalAmountMinor: number;
  respondedAt: string | null;
  responseLockedAt: string | null;
  canRespond: boolean;
  lineItems: Array<{
    position: number;
    quantity: number;
    description: string;
    unitPriceMinor: number;
    discountPercent: number;
    lineTotalMinor: number;
  }>;
  recipient: { displayName: string; email: string; companyName: string | null } | null;
  issuer: { companyName: string; email: string; website: string; footerLine: string } | null;
}

export const publicQuotesService = {
  async get(token: string): Promise<{ quote: PublicQuoteView }> {
    const { data } = await api.get(`/public/quotes/${token}`);
    return data.data || data;
  },
  async respond(token: string, action: 'accept' | 'decline'): Promise<{ status: QuoteStatus; lockedAt: string }> {
    const { data } = await api.post(`/public/quotes/${token}/respond`, { action });
    return data.data || data;
  },
};

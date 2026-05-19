/**
 * Admin → Contracts API client. Hits /api/admin/contracts/*.
 *
 * Mirrors bills.service.ts shape: `data.data || data` unwrap, blob
 * responses for PDFs via URL.createObjectURL.
 */
import { api } from '../config/api';

export type ContractStatus =
  | 'draft'
  | 'sent'
  | 'signed_by_customer'
  | 'signed_by_admin'
  | 'fully_signed'
  | 'cancelled';

export type ContractSort = 'newest' | 'oldest' | 'customer_asc';

/** Canonical section enum kept in sync with backend SECTIONS_ORDER
 *  and contractBlocksService.ALLOWED_SECTIONS. Renaming any value
 *  here also needs a backend update — there's a test that guards it. */
export type ContractBlockSection =
  | 'basics'
  | 'scope'
  | 'privacy'
  | 'commercial'
  | 'nda'
  | 'closing';

export const CONTRACT_SECTIONS: ContractBlockSection[] = [
  'basics', 'scope', 'privacy', 'commercial', 'nda', 'closing',
];

export interface ContractBlock {
  id: number;
  slug: string;
  section: ContractBlockSection;
  name: string;
  description: string | null;
  bodyText: string;
  bodyTextDe: string | null;
  isSystem: boolean;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractBlockInclusion {
  id: number;
  blockId: number;
  section: ContractBlockSection;
  position: number;
  included: boolean;
  block: {
    slug: string;
    name: string;
    description: string | null;
    bodyText: string;
    bodyTextDe: string | null;
    isSystem: boolean;
  };
  bodyTextSnapshot: string | null;
  bodyTextDeSnapshot: string | null;
}

export interface ContractSummary {
  id: number;
  contractNumber: string;
  customerAccountId: number;
  customer: {
    email: string | null;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    preferredLanguage?: string | null;
  };
  status: ContractStatus;
  language: string;
  issueDate: string;
  validUntil: string | null;
  title: string | null;
  introText: string | null;
  outroText: string | null;
  pdfPath: string | null;
  signedPdfPath: string | null;
  sentAt: string | null;
  signedByCustomerAt: string | null;
  signedByAdminAt: string | null;
  signedCustomerName: string | null;
  signedAdminName: string | null;
  createdByAdminId: number | null;
  /** Lineage back-pointers (migration 130). Used by the detail page to
   *  render "Linked quote" + "Linked invoices" panels. Null when the
   *  contract was created standalone or when the DB lineage columns
   *  haven't migrated yet. */
  sourceQuoteId?: number | null;
  convertedEventId?: number | null;
  createdAt: string;
  updatedAt: string;
  inclusions?: ContractBlockInclusion[];
}

export type ContractDetail = ContractSummary & {
  inclusions: ContractBlockInclusion[];
};

export interface ContractListResponse {
  contracts: ContractSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ContractCreatePayload {
  customerAccountId: number;
  language?: string;
  title?: string | null;
  introText?: string | null;
  outroText?: string | null;
  issueDate?: string;
  validUntil?: string;
}

export interface ContractUpdatePayload {
  title?: string | null;
  introText?: string | null;
  outroText?: string | null;
  language?: string;
  issueDate?: string;
  validUntil?: string;
  /** Full list of inclusions to write. Server rewrites the inclusion
   *  rows from this payload — caller controls inclusion + per-section
   *  order via the position field. Omit to leave inclusions untouched. */
  blocks?: Array<{ blockId: number; included?: boolean; position?: number }>;
}

export interface ContractBlockCreatePayload {
  section: ContractBlockSection;
  name: string;
  bodyText: string;
  bodyTextDe?: string | null;
  description?: string | null;
  displayOrder?: number;
  isActive?: boolean;
}

export type ContractBlockUpdatePayload = Partial<ContractBlockCreatePayload>;

export const contractsService = {
  async list(params: {
    status?: ContractStatus[];
    customerAccountId?: number;
    q?: string;
    sort?: ContractSort;
    page?: number;
    pageSize?: number;
  } = {}): Promise<ContractListResponse> {
    const { data } = await api.get('/admin/contracts', {
      params: { ...params, status: params.status?.join(',') },
    });
    return data.data || data;
  },

  async get(id: number): Promise<{ contract: ContractDetail }> {
    const { data } = await api.get(`/admin/contracts/${id}`);
    return data.data || data;
  },

  async create(payload: ContractCreatePayload): Promise<{ contract: ContractDetail }> {
    const { data } = await api.post('/admin/contracts', payload);
    return data.data || data;
  },

  async update(id: number, payload: ContractUpdatePayload): Promise<{ contract: ContractDetail }> {
    const { data } = await api.put(`/admin/contracts/${id}`, payload);
    return data.data || data;
  },

  async send(id: number): Promise<{ token: string; pdfPath: string | null }> {
    const { data } = await api.post(`/admin/contracts/${id}/send`);
    return data.data || data;
  },

  async cancel(id: number): Promise<{ status: 'cancelled' }> {
    const { data } = await api.post(`/admin/contracts/${id}/cancel`);
    return data.data || data;
  },

  /** Convert a fully-signed contract into an event + scheduled invoices.
   *  Requires source_quote_id (no line items otherwise). Idempotent — if
   *  the contract already has converted_event_id set the same event id
   *  comes back with alreadyConverted: true. */
  async convertToEvent(id: number): Promise<{ eventId: number; alreadyConverted: boolean }> {
    const { data } = await api.post(`/admin/contracts/${id}/convert-to-event`);
    return data.data || data;
  },

  /** Convert a fully-signed contract directly into invoice(s) — no event. */
  async convertToInvoice(id: number): Promise<{ installmentsCreated: number }> {
    const { data } = await api.post(`/admin/contracts/${id}/convert-to-invoice`);
    return data.data || data;
  },

  async countersign(
    id: number,
    payload: { name: string; signatureDataUrl?: string | null },
  ): Promise<{ status: ContractStatus; signedAt: string }> {
    const { data } = await api.post(`/admin/contracts/${id}/countersign`, payload);
    return data.data || data;
  },

  async uploadSignedPdf(id: number, file: File): Promise<{ status: 'fully_signed'; signedPdfPath: string }> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/admin/contracts/${id}/upload-signed-pdf`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.data || data;
  },

  async pdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/contracts/${id}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async signedPdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/contracts/${id}/signed-pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async previewPdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/contracts/${id}/preview`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  // ----- Block library -------------------------------------------------
  async listBlocks(params: { section?: ContractBlockSection; includeInactive?: boolean } = {}): Promise<{ blocks: ContractBlock[] }> {
    const { data } = await api.get('/admin/contracts/blocks', { params });
    return data.data || data;
  },

  async createBlock(payload: ContractBlockCreatePayload): Promise<{ block: ContractBlock }> {
    const { data } = await api.post('/admin/contracts/blocks', payload);
    return data.data || data;
  },

  async updateBlock(id: number, payload: ContractBlockUpdatePayload): Promise<{ block: ContractBlock }> {
    const { data } = await api.put(`/admin/contracts/blocks/${id}`, payload);
    return data.data || data;
  },

  async deleteBlock(id: number): Promise<{ ok: true }> {
    const { data } = await api.delete(`/admin/contracts/blocks/${id}`);
    return data.data || data;
  },
};

// ===================================================================
// Public client — used by ContractResponsePage (no auth, token-based).
// ===================================================================

export interface PublicContractView {
  contractNumber: string;
  status: ContractStatus;
  language: string;
  issueDate: string;
  validUntil: string | null;
  title: string | null;
  introText: string | null;
  outroText: string | null;
  sentAt: string | null;
  signedByCustomerAt: string | null;
  signedByAdminAt: string | null;
  signedCustomerName: string | null;
  signedAdminName: string | null;
  hasSignedPdf: boolean;
  canSign: boolean;
  sections: Array<{
    section: ContractBlockSection;
    blocks: Array<{
      blockId: number;
      section: ContractBlockSection;
      position: number;
      name: string;
      body: string;
    }>;
  }>;
  recipient: {
    displayName: string;
    companyName: string | null;
    email: string;
  } | null;
  issuer: {
    companyName: string | null;
    addressLine1: string | null;
    postalCode: string | null;
    city: string | null;
    email: string | null;
    website: string | null;
  } | null;
  /** Admin-set behaviour flags surfaced for the public sign page.
   *  Server re-enforces both — these only drive the UI. */
  allowPdfUpload?: boolean;
  requireDrawnSignature?: boolean;
}

export const publicContractsService = {
  async get(token: string): Promise<{ contract: PublicContractView }> {
    const { data } = await api.get(`/public/contracts/${token}`);
    return data.data || data;
  },

  async sign(token: string, payload: { name: string; signatureDataUrl?: string | null; accepted: true }): Promise<{ status: ContractStatus; signedAt: string }> {
    const { data } = await api.post(`/public/contracts/${token}/sign`, payload);
    return data.data || data;
  },

  async uploadSignedPdf(token: string, file: File): Promise<{ status: 'fully_signed'; signedPdfPath: string }> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/public/contracts/${token}/upload-signed-pdf`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.data || data;
  },
};

/**
 * Transfers API client (PicTransfer, #997).
 *
 * Three surfaces share one file:
 *   - Admin CRUD under /admin/transfers/* (cookie auth).
 *   - Public recipient download under /public/transfer/:token (token in URL).
 *   - Public client upload under /public/transfer-upload/:token (6-char token).
 */
import { api } from '../config/api';
import { getApiBaseUrl } from '../utils/url';

export interface TransferFile {
  file_id: number;
  photo_id: number;
  filename: string;
  type: string;
  size_bytes: number | null;
  event_id: number;
  event_name: string;
  event_slug: string;
  thumbnail_url: string;
}

export interface TransferUpload {
  id: number;
  original_filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  uploader_ip: string | null;
  uploaded_at: string;
}

export interface Transfer {
  id: number;
  token: string;
  title: string;
  message: string | null;
  expires_at: string;
  max_downloads: number | null;
  download_count: number;
  downloads_remaining: number | null;
  is_active: boolean;
  disabled_at: string | null;
  grace_days: number;
  deleted_at: string | null;
  allow_uploads: boolean;
  upload_token: string | null;
  upload_expires_at: string | null;
  created_at: string;
  updated_at: string;
  status: 'active' | 'expired' | 'deleted';
  download_url: string;
  upload_url: string | null;
  file_count: number;
  upload_count: number;
  files?: TransferFile[];
  uploads?: TransferUpload[];
}

export interface CreateTransferInput {
  title?: string;
  message?: string | null;
  expiresInDays?: number;
  maxDownloads?: number | null;
  graceDays?: number;
  allowUploads?: boolean;
  uploadExpiresInDays?: number;
  photoIds?: number[];
}

export interface UpdateTransferInput {
  title?: string;
  message?: string | null;
  maxDownloads?: number | null;
  graceDays?: number;
  expiresInDays?: number;
  expiresAt?: string;
  isActive?: boolean;
}

// --- Public shapes ---

export interface PublicTransferFile {
  file_id: number;
  filename: string;
  size_bytes: number | null;
}

export interface PublicTransferView {
  title: string;
  message?: string | null;
  status: 'active' | 'expired' | 'limit_reached';
  downloadable: boolean;
  expires_at: string;
  file_count?: number;
  total_bytes?: number;
  downloads_remaining?: number | null;
  files?: PublicTransferFile[];
}

export interface UploadInfo {
  title: string;
  message: string | null;
  expires_at: string;
  max_size_mb: number;
  max_files: number;
  allowed_mime: string[];
}

export const transfersService = {
  // --- Admin ---
  async list(search = ''): Promise<Transfer[]> {
    const res = await api.get('/admin/transfers', { params: search ? { q: search } : {} });
    return res.data.transfers;
  },
  async get(id: number): Promise<Transfer> {
    const res = await api.get(`/admin/transfers/${id}`);
    return res.data.transfer;
  },
  async create(input: CreateTransferInput): Promise<Transfer> {
    const res = await api.post('/admin/transfers', input);
    return res.data.transfer;
  },
  async update(id: number, input: UpdateTransferInput): Promise<Transfer> {
    const res = await api.patch(`/admin/transfers/${id}`, input);
    return res.data.transfer;
  },
  async remove(id: number): Promise<void> {
    await api.delete(`/admin/transfers/${id}`);
  },
  async addFiles(id: number, photoIds: number[]): Promise<Transfer> {
    const res = await api.post(`/admin/transfers/${id}/files`, { photoIds });
    return res.data.transfer;
  },
  async removeFile(id: number, fileId: number): Promise<Transfer> {
    const res = await api.delete(`/admin/transfers/${id}/files/${fileId}`);
    return res.data.transfer;
  },
  async enableUploads(id: number, uploadExpiresInDays?: number): Promise<Transfer> {
    const res = await api.post(`/admin/transfers/${id}/upload-link`, { uploadExpiresInDays });
    return res.data.transfer;
  },
  async disableUploads(id: number): Promise<Transfer> {
    const res = await api.delete(`/admin/transfers/${id}/upload-link`);
    return res.data.transfer;
  },
  /** Absolute API URL for the admin ZIP download (cookie auth → usable as href). */
  adminDownloadUrl(id: number): string {
    return `${getApiBaseUrl()}/admin/transfers/${id}/download`;
  },
  adminUploadDownloadUrl(id: number, uploadId: number): string {
    return `${getApiBaseUrl()}/admin/transfers/${id}/uploads/${uploadId}/download`;
  },

  // --- Public recipient ---
  async getPublic(token: string): Promise<PublicTransferView> {
    const res = await api.get(`/public/transfer/${token}`);
    return res.data.transfer;
  },
  publicDownloadAllUrl(token: string): string {
    return `${getApiBaseUrl()}/public/transfer/${token}/download`;
  },
  publicFileUrl(token: string, fileId: number): string {
    return `${getApiBaseUrl()}/public/transfer/${token}/download/${fileId}`;
  },

  // --- Public client upload ---
  async getUploadInfo(token: string): Promise<UploadInfo> {
    const res = await api.get(`/public/transfer-upload/${token}`);
    return res.data.transfer;
  },
  async upload(token: string, files: File[], onProgress?: (pct: number) => void): Promise<{ uploaded: number }> {
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    const res = await api.post(`/public/transfer-upload/${token}`, form, {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return res.data;
  },
};

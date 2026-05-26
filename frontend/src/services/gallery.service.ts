import { api } from '../config/api';
import type { GalleryInfo, GalleryData, GalleryStats, ResolvedGalleryIdentifier } from '../types';
import { normalizeRequirePassword } from '../utils/accessControl';
import { parseContentDispositionFilename } from '../utils/contentDisposition';

export const galleryService = {
  // Verify share token
  async verifyToken(slug: string, token: string): Promise<{ valid: boolean }> {
    const response = await api.get<{ valid: boolean }>(`/gallery/${slug}/verify-token/${token}`);
    return response.data;
  },

  // Get basic gallery info (no auth required)
  async getGalleryInfo(slug: string, token?: string): Promise<GalleryInfo> {
    const params = token ? { token } : {};
    const response = await api.get<GalleryInfo>(`/gallery/${slug}/info`, { params });
    const data = response.data;
    return {
      ...data,
      requires_password: normalizeRequirePassword((data as any)?.requires_password, true),
    };
  },

  // Get gallery photos (requires auth)
  async getGalleryPhotos(
    slug: string,
    filter?: 'liked' | 'favorited' | 'commented' | 'rated' | 'all',
    guestId?: string
  ): Promise<GalleryData> {
    const params: any = {};
    if (filter && filter !== 'all') {
      params.filter = filter;
      if (guestId) {
        params.guest_id = guestId;
      }
    }
    const response = await api.get<GalleryData>(`/gallery/${slug}/photos`, { params });
    const data = response.data;
    const normalizedEvent = data?.event
      ? {
          ...data.event,
          require_password: normalizeRequirePassword((data.event as any)?.require_password, true),
        }
      : data.event;
    return {
      ...data,
      event: normalizedEvent,
    };
  },

  // Save single photo via the Web Share API on mobile, falling back to a
  // regular browser download elsewhere (#531).
  //
  // On iOS Safari 15+ and Chrome Android the OS share sheet opened by
  // navigator.share() includes "Save Image" / "Save to Photos", which
  // is what non-technical clients actually want — straight into the
  // Photos / Gallery app instead of the Files folder. Desktop browsers
  // and Firefox don't implement Web Share File support, so they get the
  // existing <a download> path (file lands in Downloads, same as before).
  async savePhotoToDevice(slug: string, photoId: number, filename: string): Promise<void> {
    const fetched = await this.fetchPhotoBlob(slug, photoId);
    const resolvedFilename = fetched.serverFilename || filename;

    // canShare() returns false on browsers without Web Share file support
    // (desktop, older Safari, all Firefox as of writing). Probe with a
    // representative File so the negotiation is accurate — `canShare({
    // files: [] })` returns true on some browsers that don't actually
    // accept files at share() time.
    const file = new File([fetched.blob], resolvedFilename, {
      type: fetched.blob.type || 'image/jpeg',
    });
    const canShareFile =
      typeof navigator !== 'undefined' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] });

    if (canShareFile) {
      try {
        await navigator.share({ files: [file], title: resolvedFilename });
        return;
      } catch (err) {
        // AbortError = user dismissed the share sheet. Don't fall back —
        // they made a choice. Any other failure (NotAllowedError,
        // DataError, etc.) is unexpected; surface a download instead so
        // the user still gets the file.
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }

    this.triggerBrowserDownload(fetched.blob, resolvedFilename);
  },

  // Fetch the photo as a Blob + the server-suggested filename, falling
  // back to the view endpoint when the original isn't available. Shared
  // between the regular download flow and the Web Share path (#531).
  // The server's Content-Disposition is the source of truth for the
  // filename (#493 — "use original camera filename" toggle reaches disk
  // through this header).
  async fetchPhotoBlob(
    slug: string,
    photoId: number,
  ): Promise<{ blob: Blob; serverFilename: string | null }> {
    const readResponse = (response: { data: Blob; headers: Record<string, string> }) => {
      const headerName =
        response.headers['content-disposition'] || response.headers['Content-Disposition'];
      return {
        blob: response.data,
        serverFilename: parseContentDispositionFilename(headerName),
      };
    };

    try {
      const response = await api.get(`/gallery/${slug}/download/${photoId}`, {
        responseType: 'blob',
      });
      return readResponse(response);
    } catch {
      // Fallback: view endpoint when /download isn't available (e.g.
      // the original is missing and only a derivative remains). The
      // view endpoint doesn't emit a download-oriented Content-Disposition,
      // so serverFilename will be null and the caller's name wins.
      const response = await api.get(`/gallery/${slug}/photo/${photoId}`, {
        responseType: 'blob',
      });
      return readResponse(response);
    }
  },

  // Trigger a regular browser download via a transient <a download>
  // anchor. Extracted from downloadPhoto so the share-fallback path
  // can reuse it without re-fetching the blob.
  triggerBrowserDownload(blob: Blob, filename: string): void {
    const url = window.URL.createObjectURL(new Blob([blob]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },

  // Download single photo — kept as the canonical name for the existing
  // grid + lightbox-action callers that haven't been migrated to the
  // share-aware savePhotoToDevice path yet.
  async downloadPhoto(slug: string, photoId: number, filename: string): Promise<void> {
    const fetched = await this.fetchPhotoBlob(slug, photoId);
    this.triggerBrowserDownload(fetched.blob, fetched.serverFilename || filename);
  },

  // Download all photos as ZIP
  // When a pre-generated zip is available, use native browser download (Content-Length → progress bar).
  // Otherwise fall back to blob download.
  async downloadAllPhotos(slug: string, zipReady?: boolean): Promise<void> {
    if (zipReady) {
      // Native browser download — the server sends Content-Length so
      // the browser shows a real progress bar and mobile doesn't crash.
      const link = document.createElement('a');
      link.href = `/api/gallery/${slug}/download-all`;
      link.setAttribute('download', `${slug}.zip`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      return;
    }

    // Fallback: blob download (no Content-Length, buffered in memory)
    const response = await api.get(`/gallery/${slug}/download-all`, {
      responseType: 'blob',
    });

    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${slug}.zip`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },

  // Download selected photos as ZIP
  async downloadSelectedPhotos(slug: string, photoIds: number[]): Promise<void> {
    const response = await api.post(`/gallery/${slug}/download-selected`, { photo_ids: photoIds }, {
      responseType: 'blob',
    });

    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${slug}-selected.zip`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },

  // Toggle photo visibility (client-only)
  async togglePhotoVisibility(slug: string, photoId: number, visibility: 'visible' | 'hidden'): Promise<void> {
    await api.patch(`/gallery/${slug}/photos/${photoId}/visibility`, { visibility });
  },

  // Bulk toggle photo visibility (client-only)
  async bulkToggleVisibility(slug: string, photoIds: number[], visibility: 'visible' | 'hidden'): Promise<void> {
    await api.patch(`/gallery/${slug}/photos/visibility/bulk`, { photoIds, visibility });
  },

  // Get gallery statistics
  async getGalleryStats(slug: string): Promise<GalleryStats> {
    const response = await api.get<GalleryStats>(`/gallery/${slug}/stats`);
    return response.data;
  },

  async resolveIdentifier(identifier: string): Promise<ResolvedGalleryIdentifier> {
    const response = await api.get<ResolvedGalleryIdentifier>(`/gallery/resolve/${identifier}`);
    return response.data;
  },
};

/**
 * Customer-side API client (#354).
 *
 * Strictly separate from authService.adminLogin / galleryService — uses
 * the /api/customer/* surface and the customer_token cookie. Never falls
 * back to admin endpoints.
 */
import { api } from '../config/api';

export interface CustomerProfile {
  id: number;
  email: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  preferredLanguage: string;
}

export interface CustomerEvent {
  id: number;
  slug: string;
  eventName: string;
  eventType: string;
  eventDate: string | null;
  expiresAt: string | null;
  coverPhotoId: number | null;
  isActive: boolean;
  assignedAt: string;
}

export interface CustomerInvitationInfo {
  email: string;
  expiresAt: string;
  invitedBy: string | null;
}

export interface CustomerAccessTokenResponse {
  token: string;
  event: { id: number; slug: string; eventName: string };
}

export const customerService = {
  // ---- auth ----
  async login(email: string, password: string, recaptchaToken?: string | null): Promise<{ customer: CustomerProfile }> {
    const response = await api.post<{ customer: CustomerProfile }>(
      '/customer/auth/login',
      { email, password, recaptchaToken }
    );
    return response.data;
  },

  async logout(): Promise<void> {
    try {
      await api.post('/customer/auth/logout');
    } catch (e) {
      // Logout is best-effort — the cookie clear is what matters and
      // the backend always clears it even on error.
    }
  },

  async session(): Promise<{ customer: CustomerProfile } | null> {
    try {
      const response = await api.get<{ customer: CustomerProfile }>('/customer/auth/session');
      return response.data;
    } catch {
      return null;
    }
  },

  // ---- invitations ----
  async getInvitation(token: string): Promise<CustomerInvitationInfo> {
    const response = await api.get<{ invitation: CustomerInvitationInfo }>(
      `/customer/auth/invite/${encodeURIComponent(token)}`
    );
    return response.data.invitation;
  },

  async acceptInvitation(token: string, name: string, password: string): Promise<{ email: string }> {
    const response = await api.post<{ email: string }>(
      '/customer/auth/accept-invite',
      { token, name, password }
    );
    return response.data;
  },

  // ---- dashboard ----
  async listEvents(): Promise<CustomerEvent[]> {
    const response = await api.get<{ events: CustomerEvent[] }>('/customer/events');
    return response.data.events;
  },

  /**
   * Exchange the customer JWT for a gallery JWT scoped to one event.
   * The dashboard calls this on card-click and stores the resulting
   * token in the slug-specific gallery cookie via storeGalleryToken().
   */
  async getEventAccessToken(slug: string): Promise<CustomerAccessTokenResponse> {
    const response = await api.get<CustomerAccessTokenResponse>(
      `/customer/events/${encodeURIComponent(slug)}/access-token`
    );
    return response.data;
  },
};

/**
 * Customer dashboard (#354) — list of every gallery the admin has
 * granted this customer access to. Mounted at /customer/dashboard.
 *
 * Card click → exchange the customer JWT for a per-event gallery JWT
 * via /api/customer/events/:slug/access-token, store it in the existing
 * gallery_token_{slug} cookie, then navigate to /gallery/:slug. The
 * gallery code path needs no changes — it sees a regular gallery token
 * exactly as if the per-event password had been entered.
 */
import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Calendar, Clock, Download, ImageIcon, AlertCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';

import { Card, Loading } from '../../components/common';
import { customerService, type CustomerEvent } from '../../services/customer.service';
import { galleryService } from '../../services/gallery.service';
import { useCustomerAuth } from '../../contexts/CustomerAuthContext';
import { storeGalleryToken, setActiveGallerySlug } from '../../utils/galleryAuthStorage';
import { CustomerLayout } from './CustomerLayout';

export const CustomerDashboardPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useCustomerAuth();

  const [events, setEvents] = useState<CustomerEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [openingSlug, setOpeningSlug] = useState<string | null>(null);
  const [downloadingSlug, setDownloadingSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    let cancelled = false;
    customerService.listEvents()
      .then((rows) => {
        if (cancelled) return;
        setEvents(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('customer.dashboard.loadError', 'Could not load your galleries. Please try again.'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [authLoading, isAuthenticated, t]);

  // Routes outside the public surface: bounce to login. We wait for the
  // session check to settle so the user isn't flashed to login during
  // initial hydration.
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
        <Loading size="lg" />
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/customer/login" replace />;
  }

  /**
   * Mint a gallery JWT, store it under the slug-specific cookie, and
   * navigate to the gallery. Same code path that the gallery itself uses
   * once a guest enters the per-event password.
   */
  const openEvent = async (slug: string) => {
    if (openingSlug) return; // double-click guard
    setOpeningSlug(slug);
    try {
      const { token } = await customerService.getEventAccessToken(slug);
      storeGalleryToken(slug, token);
      setActiveGallerySlug(slug);
      navigate(`/gallery/${encodeURIComponent(slug)}`);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 410) {
        toast.error(t('customer.dashboard.eventExpired', 'This gallery has expired.'));
      } else if (status === 403) {
        toast.error(t('customer.dashboard.eventForbidden', 'You no longer have access to this gallery.'));
      } else {
        toast.error(t('customer.dashboard.openError', 'Could not open this gallery. Please try again.'));
      }
    } finally {
      setOpeningSlug(null);
    }
  };

  /**
   * Quick-download all photos as a zip without going through the gallery
   * page. Same exchange dance as openEvent (we need the gallery JWT in
   * the cookie before /gallery/:slug/download-all will accept the
   * request), then we hand off to the existing galleryService helper
   * which triggers a browser download. The cookie sticks around so a
   * follow-up "open gallery" click is a no-network-roundtrip nav.
   */
  const quickDownload = async (slug: string, eventName: string) => {
    if (downloadingSlug) return;
    setDownloadingSlug(slug);
    try {
      const { token } = await customerService.getEventAccessToken(slug);
      storeGalleryToken(slug, token);
      setActiveGallerySlug(slug);
      // Always use the blob fallback path: zipReady would require an
      // extra precheck call to the gallery info endpoint, and the
      // user wants this to be one click. The browser progress bar
      // is a nice-to-have we can add later (#386 follow-up).
      await galleryService.downloadAllPhotos(slug, false);
      toast.success(t('customer.dashboard.downloadStarted', 'Download started for {{name}}', { name: eventName }));
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 410) {
        toast.error(t('customer.dashboard.eventExpired', 'This gallery has expired.'));
      } else if (status === 403) {
        toast.error(t('customer.dashboard.eventForbidden', 'You no longer have access to this gallery.'));
      } else {
        toast.error(t('customer.dashboard.downloadError', 'Could not start the download. Please try again.'));
      }
    } finally {
      setDownloadingSlug(null);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return null;
    try { return format(parseISO(iso), 'PP'); } catch { return null; }
  };

  return (
    <CustomerLayout>
      <div className="container py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-theme">
            {t('customer.dashboard.title', 'Your galleries')}
          </h1>
          <p className="mt-1 text-sm text-muted-theme">
            {t('customer.dashboard.subtitle', 'Click a card to view the gallery.')}
          </p>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loading size="lg" /></div>
        ) : error ? (
          <Card padding="lg">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-600" />
              <p className="text-theme">{error}</p>
            </div>
          </Card>
        ) : events.length === 0 ? (
          <Card padding="lg">
            <div className="text-center py-12">
              <ImageIcon className="w-12 h-12 mx-auto mb-3 text-muted-theme" aria-hidden="true" />
              <h2 className="text-lg font-semibold text-theme mb-2">
                {t('customer.dashboard.emptyTitle', 'No galleries yet')}
              </h2>
              <p className="text-sm text-muted-theme">
                {t(
                  'customer.dashboard.emptyBody',
                  'Once your photographer assigns you to a gallery, it will appear here.'
                )}
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {events.map((ev) => {
              const date = formatDate(ev.eventDate);
              const expires = formatDate(ev.expiresAt);
              const isExpired = ev.expiresAt ? new Date(ev.expiresAt) < new Date() : false;
              const isOpening = openingSlug === ev.slug;
              const isDownloading = downloadingSlug === ev.slug;
              const cardDisabled = isExpired || openingSlug !== null || downloadingSlug !== null;
              return (
                <div
                  key={ev.id}
                  className="rounded-xl border transition-shadow"
                  style={{
                    backgroundColor: 'var(--color-surface, #ffffff)',
                    borderColor: 'var(--color-surface-border, #e5e5e5)',
                    opacity: isExpired ? 0.6 : 1,
                  }}
                >
                  {/* Most of the card is one big click-to-open button.
                      The download icon at the bottom-right gets its own
                      button so the click doesn't bubble up. */}
                  <button
                    type="button"
                    onClick={() => openEvent(ev.slug)}
                    disabled={cardDisabled}
                    className="w-full text-left p-5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed"
                    aria-label={t('customer.dashboard.openAria', 'Open gallery {{name}}', { name: ev.eventName })}
                  >
                    <h3 className="text-base font-semibold text-theme mb-2 line-clamp-2">
                      {ev.eventName}
                    </h3>
                    <div className="space-y-1 text-sm text-muted-theme">
                      {date && (
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 flex-shrink-0" />
                          <span>{date}</span>
                        </div>
                      )}
                      {expires && (
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 flex-shrink-0" />
                          <span>
                            {isExpired
                              ? t('customer.dashboard.expiredOn', 'Expired {{date}}', { date: expires })
                              : t('customer.dashboard.expiresOn', 'Expires {{date}}', { date: expires })}
                          </span>
                        </div>
                      )}
                    </div>
                    {isOpening && (
                      <div className="mt-3 text-xs" style={{ color: 'var(--color-accent)' }}>
                        {t('customer.dashboard.opening', 'Opening…')}
                      </div>
                    )}
                  </button>

                  {/*
                    Quick-download button. Bypasses the gallery page so the
                    customer can grab the zip in one click. Disabled on
                    expired galleries and while another card-level action
                    is in flight, to avoid two simultaneous downloads
                    fighting over the same gallery_token cookie.
                  */}
                  {!isExpired && (
                    <div className="px-5 pb-5 -mt-1 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => quickDownload(ev.slug, ev.eventName)}
                        disabled={cardDisabled}
                        aria-label={t('customer.dashboard.quickDownloadAria', 'Download all photos for {{name}}', { name: ev.eventName })}
                        className="inline-flex items-center gap-2 px-3 h-9 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                        style={{ backgroundColor: 'var(--color-accent)' }}
                      >
                        <Download className="w-4 h-4" />
                        <span>
                          {isDownloading
                            ? t('customer.dashboard.preparingDownload', 'Preparing…')
                            : t('customer.dashboard.download', 'Download')}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </CustomerLayout>
  );
};

export default CustomerDashboardPage;

/**
 * Public recipient download page for PicTransfer (#997).
 *
 * Token-only (no auth). By design there are NO thumbnails — just filenames,
 * sizes and a prominent "Download all" button, plus per-file download.
 * Files served are always ORIGINALS.
 *
 * Styling reads the branding theme CSS variables (`--color-*`) rather than
 * Tailwind neutral/`dark:` utilities: this is a public page, so it never gets
 * the admin `.dark` class — the only theming that reaches it is the instance
 * branding (colours + light/dark) applied by GlobalThemeProvider. Reading the
 * vars keeps it on-brand and correct in both light and dark.
 */
import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, FileDown, Clock, PackageOpen, AlertCircle } from 'lucide-react';

import { Button, Loading } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { transfersService } from '../../services/transfers.service';

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const TransferDownloadPage: React.FC = () => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { token } = useParams<{ token: string }>();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-transfer', token],
    queryFn: () => transfersService.getPublic(token as string),
    enabled: !!token,
    retry: false,
  });

  const wrap = (children: React.ReactNode) => (
    <div
      className="flex min-h-screen items-center justify-center p-4"
      style={{ backgroundColor: 'var(--color-background)', color: 'var(--color-text)' }}
    >
      <div
        className="w-full max-w-lg rounded-lg border shadow-sm"
        style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-surface-border)' }}
      >
        {children}
      </div>
    </div>
  );

  const muted = { color: 'var(--color-muted-text)' } as const;

  if (isLoading) return wrap(<div className="p-6"><Loading /></div>);

  if (isError || !data) {
    return wrap(
      <div className="p-8 text-center">
        <AlertCircle className="mx-auto mb-3 h-12 w-12" style={muted} />
        <h1 className="text-xl font-semibold">{t('transfers.public.notFoundTitle', 'Link not found')}</h1>
        <p className="mt-2" style={muted}>{t('transfers.public.notFoundBody', 'This transfer link is invalid or has been removed.')}</p>
      </div>,
    );
  }

  if (!data.downloadable) {
    const isLimit = data.status === 'limit_reached';
    return wrap(
      <div className="p-8 text-center">
        <Clock className="mx-auto mb-3 h-12 w-12" style={muted} />
        <h1 className="text-xl font-semibold">
          {isLimit ? t('transfers.public.limitTitle', 'Download limit reached') : t('transfers.public.expiredTitle', 'This link has expired')}
        </h1>
        <p className="mt-2" style={muted}>
          {isLimit
            ? t('transfers.public.limitBody', 'This transfer has reached its maximum number of downloads.')
            : t('transfers.public.expiredBody', 'Please ask the sender for a new link.')}
        </p>
      </div>,
    );
  }

  return wrap(
    <div className="p-6">
      <div className="mb-5 text-center">
        <PackageOpen className="mx-auto mb-2 h-10 w-10" style={{ color: 'var(--color-accent)' }} />
        <h1 className="text-2xl font-bold">{data.title}</h1>
        {data.message && <p className="mt-2 whitespace-pre-line" style={muted}>{data.message}</p>}
        <p className="mt-2 text-sm" style={muted}>
          {t('transfers.public.fileSummary', '{{count}} files', { count: data.file_count || 0 })}
          {data.total_bytes ? ` · ${formatBytes(data.total_bytes)}` : ''}
        </p>
      </div>

      {/* Prominent download-all */}
      <a href={transfersService.publicDownloadAllUrl(token as string)} className="block">
        <Button size="lg" leftIcon={<Download className="h-5 w-5" />} className="w-full">
          {t('transfers.downloadAll', 'Download all')}
        </Button>
      </a>

      {data.files && data.files.length > 0 && (
        <ul className="mt-5 border-t" style={{ borderColor: 'var(--color-surface-border)' }}>
          {data.files.map((f) => (
            <li
              key={f.file_id}
              className="flex items-center justify-between border-b py-2.5 text-sm"
              style={{ borderColor: 'var(--color-surface-border)' }}
            >
              <span className="mr-3 truncate">{f.filename}</span>
              <span className="flex shrink-0 items-center gap-3" style={muted}>
                {f.size_bytes ? <span>{formatBytes(f.size_bytes)}</span> : null}
                <a
                  href={transfersService.publicFileUrl(token as string, f.file_id)}
                  className="rounded p-1.5 hover:opacity-70"
                  style={{ color: 'var(--color-accent)' }}
                  title={t('transfers.public.downloadFile', 'Download')}
                >
                  <FileDown className="h-4 w-4" />
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}

      {data.expires_at && (
        <p className="mt-5 text-center text-xs" style={muted}>
          {t('transfers.public.availableUntil', 'Available until {{date}}', { date: format(data.expires_at) })}
        </p>
      )}
    </div>,
  );
};

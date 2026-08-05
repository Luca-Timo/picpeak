/**
 * Public client-upload page for PicTransfer (#997).
 *
 * Token-only (6-char code, no auth). Lets a client send files back to the
 * photographer (logos etc.). Reached via /transfer-upload/:token.
 */
import React, { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { UploadCloud, CheckCircle, AlertCircle, X, File as FileIcon } from 'lucide-react';

import { Button, Card, CardContent, Loading } from '../../components/common';
import { transfersService } from '../../services/transfers.service';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const TransferUploadPage: React.FC = () => {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['transfer-upload-info', token],
    queryFn: () => transfersService.getUploadInfo(token as string),
    enabled: !!token,
    retry: false,
  });

  const wrap = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
      <div className="w-full max-w-lg">{children}</div>
    </div>
  );

  if (isLoading) return wrap(<Loading />);

  if (isError || !data) {
    return wrap(
      <Card>
        <CardContent className="py-12 text-center">
          <AlertCircle className="mx-auto mb-3 h-12 w-12 text-neutral-300" />
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('transfers.upload.unavailableTitle', 'Upload link unavailable')}</h1>
          <p className="mt-2 text-neutral-500">{t('transfers.upload.unavailableBody', 'This upload link is invalid or has expired.')}</p>
        </CardContent>
      </Card>,
    );
  }

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => {
      const merged = [...prev, ...incoming].slice(0, data.max_files);
      return merged;
    });
  };

  const handleUpload = async () => {
    if (!files.length) return;
    const tooBig = files.find((f) => f.size > data.max_size_mb * 1024 * 1024);
    if (tooBig) {
      toast.error(t('transfers.upload.tooBig', 'Each file must be {{mb}} MB or smaller', { mb: data.max_size_mb }));
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      await transfersService.upload(token as string, files, setProgress);
      setDone(true);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || t('transfers.upload.failed', 'Upload failed. Please try again.');
      toast.error(msg);
    } finally {
      setUploading(false);
    }
  };

  if (done) {
    return wrap(
      <Card>
        <CardContent className="py-12 text-center">
          <CheckCircle className="mx-auto mb-3 h-12 w-12 text-green-500" />
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('transfers.upload.doneTitle', 'Thank you!')}</h1>
          <p className="mt-2 text-neutral-500">{t('transfers.upload.doneBody', 'Your files were uploaded successfully.')}</p>
          <Button className="mt-5" variant="outline" onClick={() => { setDone(false); setFiles([]); setProgress(0); }}>
            {t('transfers.upload.uploadMore', 'Upload more')}
          </Button>
        </CardContent>
      </Card>,
    );
  }

  return wrap(
    <Card>
      <CardContent className="p-6">
        <div className="mb-5 text-center">
          <UploadCloud className="mx-auto mb-2 h-10 w-10 text-primary-500" />
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{data.title}</h1>
          {data.message && <p className="mt-2 whitespace-pre-line text-neutral-600 dark:text-neutral-400">{data.message}</p>}
          <p className="mt-2 text-sm text-neutral-500">
            {t('transfers.upload.limits', 'Up to {{files}} files, {{mb}} MB each', { files: data.max_files, mb: data.max_size_mb })}
          </p>
        </div>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-neutral-300 py-10 text-neutral-500 transition hover:border-primary-400 hover:text-primary-600 dark:border-neutral-600"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
        >
          <UploadCloud className="mb-2 h-8 w-8" />
          <span className="text-sm">{t('transfers.upload.dropzone', 'Click to choose files or drag them here')}</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); if (inputRef.current) inputRef.current.value = ''; }}
        />

        {files.length > 0 && (
          <ul className="mt-4 divide-y divide-neutral-100 dark:divide-neutral-800">
            {files.map((f, idx) => (
              <li key={`${f.name}-${idx}`} className="flex items-center justify-between py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <FileIcon className="h-4 w-4 shrink-0 text-neutral-400" />
                  <span className="truncate text-neutral-700 dark:text-neutral-300">{f.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 text-neutral-500">
                  <span>{formatBytes(f.size)}</span>
                  {!uploading && (
                    <button onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))} className="rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {uploading && (
          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
            <div className="h-full bg-primary-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}

        <Button
          className="mt-5 w-full"
          size="lg"
          leftIcon={<UploadCloud className="h-5 w-5" />}
          onClick={handleUpload}
          disabled={files.length === 0}
          isLoading={uploading}
        >
          {t('transfers.upload.send', 'Upload {{count}} files', { count: files.length })}
        </Button>
      </CardContent>
    </Card>,
  );
};

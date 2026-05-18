/**
 * Public contract response page. No authentication — the link in the
 * customer's email is the only secret.
 *
 * Two signing paths offered side-by-side:
 *   1. In-browser: customer types their full name, optionally draws a
 *      signature on a small canvas, ticks "I have read and agree", and
 *      submits. Server captures IP + timestamp + the signature image,
 *      re-renders the PDF with the signature stamped, and emails the
 *      admin a notification.
 *   2. Upload wet-signed PDF: customer can sign physically and upload
 *      the PDF instead. Server treats this as the authoritative copy.
 *
 * No external dependency — the canvas drawing is implemented with
 * plain pointer events. Lightweight by design; if a richer signature
 * UX is needed later we can layer signature_pad on top.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Upload, RotateCcw, FileDown } from 'lucide-react';
import {
  publicContractsService,
  type ContractBlockSection,
} from '../../services/contracts.service';

interface SignaturePadHandle {
  toDataURL(): string;
  clear(): void;
  isEmpty(): boolean;
}

function useSignaturePad(): [
  React.RefObject<HTMLCanvasElement>,
  SignaturePadHandle,
] {
  const ref = useRef<HTMLCanvasElement>(null);
  const drewRef = useRef(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let drawing = false;
    function point(ev: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left) * (canvas!.width / rect.width),
        y: (ev.clientY - rect.top) * (canvas!.height / rect.height),
      };
    }
    function down(ev: PointerEvent) {
      drawing = true;
      drewRef.current = true;
      const p = point(ev);
      ctx!.beginPath();
      ctx!.moveTo(p.x, p.y);
      canvas!.setPointerCapture(ev.pointerId);
    }
    function move(ev: PointerEvent) {
      if (!drawing) return;
      const p = point(ev);
      ctx!.lineTo(p.x, p.y);
      ctx!.stroke();
    }
    function up() { drawing = false; }

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', up);

    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', up);
    };
  }, []);

  const handle: SignaturePadHandle = {
    toDataURL: () => ref.current?.toDataURL('image/png') || '',
    clear: () => {
      const canvas = ref.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      drewRef.current = false;
    },
    isEmpty: () => !drewRef.current,
  };
  return [ref, handle];
}

const SECTION_LABELS: Record<ContractBlockSection, { en: string; de: string }> = {
  basics: { en: 'Basics', de: 'Vertragsgrundlagen' },
  scope: { en: 'Scope', de: 'Leistungsumfang' },
  privacy: { en: 'Privacy', de: 'Persönlichkeitsrechte & Datenschutz' },
  commercial: { en: 'Commercial', de: 'Kaufmännisches' },
  nda: { en: 'Confidentiality', de: 'Vertraulichkeit' },
  closing: { en: 'Closing', de: 'Schlussbestimmungen' },
};

export const ContractResponsePage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const [canvasRef, sig] = useSignaturePad();

  const [name, setName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['public-contract', token],
    queryFn: () => publicContractsService.get(token as string),
    enabled: !!token,
    retry: false,
  });

  const signMutation = useMutation({
    mutationFn: async () => {
      const signatureDataUrl = sig.isEmpty() ? null : sig.toDataURL();
      return publicContractsService.sign(token as string, {
        name: name.trim(),
        signatureDataUrl,
        accepted: true,
      });
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['public-contract', token] });
    },
    onError: (err: any) => setError(err?.response?.data?.error || 'Failed to sign'),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => publicContractsService.uploadSignedPdf(token as string, file),
    onSuccess: () => {
      setError(null);
      setUploadFile(null);
      queryClient.invalidateQueries({ queryKey: ['public-contract', token] });
    },
    onError: (err: any) => setError(err?.response?.data?.error || 'Upload failed'),
  });

  function handleSign(e: React.FormEvent) {
    e.preventDefault();
    if (!accepted) {
      setError(t('publicContract.errorAccept', 'Please tick the acceptance box.') as string);
      return;
    }
    if (!name.trim()) {
      setError(t('publicContract.errorName', 'Please enter your name.') as string);
      return;
    }
    setError(null);
    signMutation.mutate();
  }

  if (isLoading) return <div className="p-8 text-center">Loading…</div>;
  if (loadError || !data) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center">
        <h1 className="text-xl font-semibold mb-2">
          {t('publicContract.notFoundTitle', 'Contract not available')}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t('publicContract.notFoundBody', 'This signing link is invalid or expired. Please contact the sender.')}
        </p>
      </div>
    );
  }

  const c = data.contract;
  const locale = (c.language === 'de' ? 'de' : 'en') as 'en' | 'de';
  const alreadySigned = c.status !== 'sent' && (c.status === 'signed_by_customer' || c.status === 'signed_by_admin' || c.status === 'fully_signed');

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8">
      {/* Issuer / recipient */}
      <header className="mb-6 pb-4 border-b border-neutral-200 dark:border-neutral-700">
        {c.issuer && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {c.issuer.companyName} — {c.issuer.addressLine1}, {c.issuer.postalCode} {c.issuer.city}
          </p>
        )}
        <h1 className="text-2xl md:text-3xl font-bold mt-2">
          {c.title || t('publicContract.fallbackTitle', 'Contract')}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          <span className="font-mono">{c.contractNumber}</span>
          {c.recipient && <span> · {c.recipient.companyName || c.recipient.displayName}</span>}
        </p>
      </header>

      {/* Intro */}
      {c.introText && (
        <p className="mb-6 whitespace-pre-line text-sm leading-6">{c.introText}</p>
      )}

      {/* Sections + blocks */}
      {c.sections.map((sec) => (
        <section key={sec.section} className="mb-8">
          <h2 className="text-xl font-semibold mb-3 border-b border-neutral-200 dark:border-neutral-700 pb-1">
            {SECTION_LABELS[sec.section]?.[locale] || sec.section}
          </h2>
          {sec.blocks.map((blk) => (
            <article key={blk.blockId} className="mb-4">
              <h3 className="font-semibold text-sm mb-1">{blk.name}</h3>
              <p className="text-sm whitespace-pre-line leading-6">{blk.body}</p>
            </article>
          ))}
        </section>
      ))}

      {/* Outro */}
      {c.outroText && (
        <p className="mb-6 whitespace-pre-line text-sm leading-6">{c.outroText}</p>
      )}

      {/* Signing area */}
      <section className="mt-10 p-4 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900">
        {alreadySigned ? (
          <div className="text-center py-4">
            <CheckCircle className="w-12 h-12 mx-auto text-green-600 mb-3" />
            <h2 className="text-lg font-semibold">
              {t('publicContract.signed.title', 'Thank you — the contract is signed.')}
            </h2>
            {c.signedCustomerName && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
                {t('publicContract.signed.by', 'Signed by')}: {c.signedCustomerName}
              </p>
            )}
            {c.signedByAdminAt && c.signedAdminName && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {t('publicContract.signed.counterBy', 'Counter-signed by')}: {c.signedAdminName}
              </p>
            )}
          </div>
        ) : (
          <>
            <h2 className="text-lg font-semibold mb-3">
              {t('publicContract.signTitle', 'Sign this contract')}
            </h2>

            <form onSubmit={handleSign} className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('publicContract.nameField', 'Your full name')}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('publicContract.signaturePrompt', 'Draw your signature (optional)')}
                </label>
                <canvas
                  ref={canvasRef}
                  width={600}
                  height={150}
                  className="w-full h-32 bg-white rounded border border-neutral-300 dark:border-neutral-600 touch-none"
                />
                <div className="mt-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => sig.clear()}
                    className="text-xs text-neutral-600 hover:text-accent-dark inline-flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" />
                    {t('publicContract.clearSignature', 'Clear')}
                  </button>
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  {t(
                    'publicContract.acceptCheckbox',
                    'I have read this contract and agree to be bound by its terms.',
                  )}
                </span>
              </label>

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={signMutation.isPending}
                  className="px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90 disabled:opacity-50"
                >
                  {t('publicContract.submit', 'Sign contract')}
                </button>
              </div>
            </form>

            {/* Alternative: upload wet-signed PDF */}
            <div className="mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700">
              <h3 className="text-sm font-semibold mb-2">
                {t('publicContract.uploadAlternative', 'Or upload a wet-signed PDF')}
              </h3>
              <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-2">
                {t(
                  'publicContract.uploadHint',
                  'Sign the printed contract by hand, scan it, and upload the PDF here.',
                )}
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  className="text-sm"
                />
                <button
                  type="button"
                  disabled={!uploadFile || uploadMutation.isPending}
                  onClick={() => uploadFile && uploadMutation.mutate(uploadFile)}
                  className="px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-600 text-sm inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <Upload className="w-4 h-4" />
                  {t('publicContract.uploadButton', 'Upload signed PDF')}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
};

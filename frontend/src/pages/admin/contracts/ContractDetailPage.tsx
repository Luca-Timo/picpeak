/**
 * Admin → Contract detail page.
 *
 * Read-only view for sent / signed / cancelled contracts. Surfaces:
 *   - Status + signing evidence (names, IPs, timestamps)
 *   - PDF download + signed-PDF download (when present)
 *   - "Counter-sign" form when customer has signed
 *   - "Upload signed PDF" file picker (admin path)
 *   - "Send" / "Cancel" buttons for drafts
 *
 * The actual editor lives at /:id/edit and refuses to load when the
 * contract is no longer in draft status.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { billsService } from '../../../services/bills.service';
import { quotesService } from '../../../services/quotes.service';
import SignaturePad from 'signature_pad';
import {
  ArrowLeft, Edit2, Send, X, FileDown, Upload, CheckSquare, ScrollText,
  ArrowRightCircle, Receipt, RotateCcw, MailCheck,
} from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import {
  contractsService,
  type ContractStatus,
} from '../../../services/contracts.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

function statusBadgeClass(status: ContractStatus): string {
  return status === 'fully_signed'         ? 'bg-green-100 text-green-800'
    : status === 'signed_by_customer'      ? 'bg-blue-100 text-blue-800'
    : status === 'signed_by_admin'         ? 'bg-blue-100 text-blue-800'
    : status === 'sent'                    ? 'bg-amber-100 text-amber-800'
    : status === 'cancelled'               ? 'bg-neutral-200 text-neutral-600'
    :                                        'bg-neutral-100 text-neutral-700';
}

export const ContractDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { format } = useLocalizedDate();
  const formatDate = (v: string | null | undefined) => v ? format(v) : '—';
  const formatDateTime = (v: string | null | undefined) => v ? format(v, 'PPpp') : '—';
  const numericId = id ? parseInt(id, 10) : null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const countersignCanvasRef = useRef<HTMLCanvasElement>(null);
  const countersignPadRef = useRef<SignaturePad | null>(null);

  const [countersignName, setCountersignName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['contract', numericId],
    queryFn: () => contractsService.get(numericId as number),
    enabled: numericId !== null,
  });

  // Lineage: pull the source quote's number AND every invoice whose
  // source_contract_id matches this contract. Both queries are gated
  // off `data` so they only fire after the contract loads. React-Query
  // handles caching so navigating between contract/quote/bill detail
  // pages doesn't refetch.
  const sourceQuoteId = data?.contract?.sourceQuoteId ?? null;
  const { data: sourceQuoteData } = useQuery({
    queryKey: ['quote', sourceQuoteId],
    queryFn: () => quotesService.get(sourceQuoteId as number),
    enabled: !!sourceQuoteId,
  });
  const { data: linkedInvoices } = useQuery({
    queryKey: ['contract-invoices', numericId],
    queryFn: () => billsService.list({ pageSize: 50 } as any),
    enabled: numericId !== null,
    // Filter client-side because the bills endpoint doesn't support
    // sourceContractId yet. The bills list response is capped at 50
    // most-recent — sufficient for contract → invoice flows.
    select: (res) => res?.invoices?.filter((i) => i.sourceContractId === numericId) || [],
  });

  const sendMutation = useMutation({
    mutationFn: () => contractsService.send(numericId as number),
    onSuccess: () => {
      toast.success(t('contracts.detail.sentToast', 'Contract sent.') as string);
      queryClient.invalidateQueries({ queryKey: ['contract', numericId] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.detail.sendError', 'Send failed') as string),
  });

  const cancelMutation = useMutation({
    mutationFn: () => contractsService.cancel(numericId as number),
    onSuccess: () => {
      toast.success(t('contracts.detail.cancelledToast', 'Contract cancelled.') as string);
      queryClient.invalidateQueries({ queryKey: ['contract', numericId] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.detail.cancelError', 'Cancel failed') as string),
  });

  const countersignMutation = useMutation({
    mutationFn: () => {
      // Capture the canvas signature (if drawn) at submit time so we
      // send a fresh data URL, not a stale one from an earlier mount.
      const pad = countersignPadRef.current;
      const signatureDataUrl = pad && !pad.isEmpty() ? pad.toDataURL('image/png') : null;
      return contractsService.countersign(numericId as number, {
        name: countersignName,
        signatureDataUrl,
      });
    },
    onSuccess: () => {
      toast.success(t('contracts.detail.countersignedToast', 'Counter-signed.') as string);
      setCountersignName('');
      countersignPadRef.current?.clear();
      queryClient.invalidateQueries({ queryKey: ['contract', numericId] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.detail.countersignError', 'Counter-sign failed') as string),
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => contractsService.uploadSignedPdf(numericId as number, file),
    onSuccess: () => {
      toast.success(t('contracts.detail.uploadedToast', 'Signed PDF uploaded.') as string);
      queryClient.invalidateQueries({ queryKey: ['contract', numericId] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.detail.uploadError', 'Upload failed') as string),
  });

  const resendSignedMutation = useMutation({
    mutationFn: () => contractsService.resendSigned(numericId as number),
    onSuccess: () => {
      toast.success(t('contracts.detail.resentSignedToast',
        'Signed contract re-sent to both parties.') as string);
      queryClient.invalidateQueries({ queryKey: ['contract', numericId] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error
      || t('contracts.detail.resendError', 'Resend failed') as string),
  });

  const convertToEventMutation = useMutation({
    mutationFn: () => contractsService.convertToEvent(numericId as number),
    onSuccess: (result) => {
      toast.success(result.alreadyConverted
        ? (t('contracts.detail.alreadyEventToast', 'Already linked to an event.') as string)
        : (t('contracts.detail.convertedToEventToast', 'Contract converted to event #{{id}}', { id: result.eventId }) as string));
      queryClient.invalidateQueries({ queryKey: ['contract', numericId] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.detail.convertError', 'Convert failed') as string),
  });

  const convertToInvoiceMutation = useMutation({
    mutationFn: () => contractsService.convertToInvoice(numericId as number),
    onSuccess: (result) => {
      toast.success(t('contracts.detail.convertedToInvoiceToast',
        '{{count}} invoice(s) created from this contract', { count: result.installmentsCreated }) as string);
      queryClient.invalidateQueries({ queryKey: ['contract', numericId] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.detail.convertError', 'Convert failed') as string),
  });

  if (isLoading) return <Loading />;
  if (!data || !data.contract) {
    return (
      <Card padding="lg">
        <p>{t('contracts.detail.notFound', 'Contract not found.')}</p>
      </Card>
    );
  }
  const c = data.contract;

  async function handlePdfDownload() {
    if (!numericId) return;
    // Sync-open BEFORE await so the popup blocker accepts the gesture.
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('contracts.detail.popupBlocked', 'Allow pop-ups for this site to preview the PDF.') as string);
      return;
    }
    try {
      const url = await contractsService.pdfUrl(numericId);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || 'PDF unavailable');
    }
  }

  async function handleSignedPdfDownload() {
    if (!numericId) return;
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('contracts.detail.popupBlocked', 'Allow pop-ups for this site to preview the PDF.') as string);
      return;
    }
    try {
      const url = await contractsService.signedPdfUrl(numericId);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || 'Signed PDF unavailable');
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Link
          to="/admin/clients/contracts"
          className="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:text-accent-dark"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('contracts.detail.back', 'Back to list')}
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2 flex-1">
          <ScrollText className="w-6 h-6" />
          <span className="font-mono text-base">{c.contractNumber}</span>
          {c.title && <span className="text-base text-neutral-600 dark:text-neutral-400">— {c.title}</span>}
        </h1>
        <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${statusBadgeClass(c.status)}`}>
          {t(`contracts.status.${c.status}`, c.status)}
        </span>
      </div>

      {/* Action bar */}
      <div className="mb-4 flex flex-wrap gap-2">
        {c.status === 'draft' && (
          <>
            <Button variant="outline" onClick={() => navigate(`/admin/clients/contracts/${c.id}/edit`)}>
              <Edit2 className="w-4 h-4 mr-1" />
              {t('contracts.detail.edit', 'Edit')}
            </Button>
            <Button onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending}>
              <Send className="w-4 h-4 mr-1" />
              {t('contracts.detail.send', 'Send to customer')}
            </Button>
          </>
        )}
        {(c.status === 'draft' || c.status === 'sent') && (
          <Button
            variant="outline"
            onClick={() => {
              if (window.confirm(t('contracts.detail.cancelConfirm', 'Cancel this contract? Customer signing link will be invalidated.') as string)) {
                cancelMutation.mutate();
              }
            }}
            disabled={cancelMutation.isPending}
          >
            <X className="w-4 h-4 mr-1" />
            {t('contracts.detail.cancel', 'Cancel')}
          </Button>
        )}
        {c.pdfPath && (
          <Button variant="outline" onClick={handlePdfDownload}>
            <FileDown className="w-4 h-4 mr-1" />
            {t('contracts.detail.downloadPdf', 'Download PDF')}
          </Button>
        )}
        {c.signedPdfPath && (
          <Button variant="outline" onClick={handleSignedPdfDownload}>
            <FileDown className="w-4 h-4 mr-1" />
            {t('contracts.detail.downloadSignedPdf', 'Download signed PDF')}
          </Button>
        )}
        {/* Recovery action — on fully-signed contracts, lets the admin
            re-render the signed PDF (if a previous render failed) and
            resend the confirmation email to both parties. Also useful
            when the customer claims they didn't receive it. */}
        {c.status === 'fully_signed' && (
          <Button
            variant="outline"
            onClick={() => {
              if (window.confirm(t('contracts.detail.confirmResendSigned',
                'Re-send the signed contract PDF to both parties?') as string)) {
                resendSignedMutation.mutate();
              }
            }}
            disabled={resendSignedMutation.isPending}
          >
            <MailCheck className="w-4 h-4 mr-1" />
            {t('contracts.detail.resendSigned', 'Re-send signed PDF')}
          </Button>
        )}
        {(c.status === 'sent' || c.status === 'signed_by_customer') && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadMutation.mutate(f);
                if (e.target) e.target.value = '';
              }}
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              <Upload className="w-4 h-4 mr-1" />
              {t('contracts.detail.uploadSigned', 'Upload signed PDF')}
            </Button>
          </>
        )}

        {/* Forward conversions — only available once both parties have
            signed AND the contract has a source quote (no line items
            otherwise). Mirrors the buttons that live on QuoteDetailPage
            for accepted quotes. */}
        {c.status === 'fully_signed' && (
          <>
            <Button
              onClick={() => {
                if (window.confirm(t('contracts.detail.confirmConvertEvent',
                  'Convert this contract into an event + scheduled invoices?') as string)) {
                  convertToEventMutation.mutate();
                }
              }}
              disabled={convertToEventMutation.isPending}
            >
              <ArrowRightCircle className="w-4 h-4 mr-1" />
              {t('contracts.detail.convertToEvent', 'Convert to event')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (window.confirm(t('contracts.detail.confirmConvertInvoice',
                  'Convert this contract into invoice(s) only? No gallery / event will be created.') as string)) {
                  convertToInvoiceMutation.mutate();
                }
              }}
              disabled={convertToInvoiceMutation.isPending}
            >
              <Receipt className="w-4 h-4 mr-1" />
              {t('contracts.detail.convertToInvoice', 'Convert to invoice only')}
            </Button>
          </>
        )}
      </div>

      {/* Recipient + dates */}
      <Card padding="lg" className="mb-4">
        <h2 className="font-semibold mb-2">{t('contracts.detail.parties', 'Parties')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs uppercase text-neutral-500 tracking-wide">
              {t('contracts.detail.customer', 'Customer')}
            </p>
            <p className="font-medium">
              {c.customer.companyName
                || [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ')
                || c.customer.displayName
                || c.customer.email}
            </p>
            <p className="text-xs text-neutral-500">{c.customer.email}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-neutral-500 tracking-wide">
              {t('contracts.detail.dates', 'Dates')}
            </p>
            <p className="text-xs">
              <span className="text-neutral-500">{t('contracts.detail.issued', 'Issued')}: </span>
              {formatDate(c.issueDate)}
            </p>
            {c.validUntil && (
              <p className="text-xs">
                <span className="text-neutral-500">{t('contracts.detail.signBy', 'Sign by')}: </span>
                {formatDate(c.validUntil)}
              </p>
            )}
            {c.sentAt && (
              <p className="text-xs">
                <span className="text-neutral-500">{t('contracts.detail.sentAt', 'Sent at')}: </span>
                {formatDateTime(c.sentAt)}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Signature evidence */}
      {(c.signedByCustomerAt || c.signedByAdminAt) && (
        <Card padding="lg" className="mb-4">
          <h2 className="font-semibold mb-2">{t('contracts.detail.signatures', 'Signatures')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="p-3 rounded border border-neutral-200 dark:border-neutral-700">
              <p className="text-xs uppercase text-neutral-500 tracking-wide">
                {t('contracts.detail.signedByCustomer', 'Signed by customer')}
              </p>
              {c.signedByCustomerAt ? (
                <>
                  <p className="font-medium">{c.signedCustomerName}</p>
                  <p className="text-xs text-neutral-500">{formatDateTime(c.signedByCustomerAt)}</p>
                </>
              ) : (
                <p className="text-xs text-neutral-500">—</p>
              )}
            </div>
            <div className="p-3 rounded border border-neutral-200 dark:border-neutral-700">
              <p className="text-xs uppercase text-neutral-500 tracking-wide">
                {t('contracts.detail.signedByAdmin', 'Counter-signed')}
              </p>
              {c.signedByAdminAt ? (
                <>
                  <p className="font-medium">{c.signedAdminName}</p>
                  <p className="text-xs text-neutral-500">{formatDateTime(c.signedByAdminAt)}</p>
                </>
              ) : (
                <p className="text-xs text-neutral-500">—</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Counter-sign form. Mirrors the public sign page: typed name +
          drawn signature (signature_pad) so the rendered PDF carries
          both signatures, not just typed labels. */}
      {c.status === 'signed_by_customer' && !c.signedByAdminAt && (
        <CountersignCard
          name={countersignName}
          setName={setCountersignName}
          canvasRef={countersignCanvasRef}
          padRef={countersignPadRef}
          onSubmit={() => countersignMutation.mutate()}
          pending={countersignMutation.isPending}
        />
      )}

      {/* Lineage: source quote + resulting event + resulting invoices.
          Renders only when at least one side has data so contracts
          created standalone don't show empty panels. Mirrors the
          "Resulting invoices" pattern on QuoteDetailPage. */}
      {(sourceQuoteId || c.convertedEventId || (linkedInvoices && linkedInvoices.length > 0)) && (
        <Card padding="lg" className="mb-4">
          <h2 className="font-semibold mb-2">{t('contracts.detail.lineage', 'Linked documents')}</h2>
          <div className="space-y-2 text-sm">
            {sourceQuoteId && (
              <div className="flex items-center gap-2">
                <span className="text-neutral-500 w-32">{t('contracts.detail.fromQuote', 'From quote')}:</span>
                <Link
                  to={`/admin/clients/quotes/${sourceQuoteId}`}
                  className="text-accent-dark hover:underline font-mono"
                >
                  {sourceQuoteData?.quote?.quoteNumber || `#${sourceQuoteId}`}
                </Link>
              </div>
            )}
            {c.convertedEventId && (
              <div className="flex items-center gap-2">
                <span className="text-neutral-500 w-32">{t('contracts.detail.convertedToEvent', 'Converted to event')}:</span>
                <Link
                  to={`/admin/events/${c.convertedEventId}`}
                  className="text-accent-dark hover:underline font-mono"
                >
                  #{c.convertedEventId}
                </Link>
              </div>
            )}
            {linkedInvoices && linkedInvoices.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="text-neutral-500 w-32 flex-shrink-0">{t('contracts.detail.linkedInvoices', 'Resulting invoices')}:</span>
                <ul className="space-y-1">
                  {linkedInvoices.map((inv) => (
                    <li key={inv.id}>
                      <Link
                        to={`/admin/clients/bills/${inv.id}`}
                        className="text-accent-dark hover:underline font-mono"
                      >
                        {inv.invoiceNumber}
                      </Link>
                      <span className="ml-2 text-xs text-neutral-500">
                        {t(`bills.status.${inv.status}`, inv.status)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Block summary */}
      <Card padding="lg">
        <h2 className="font-semibold mb-2">{t('contracts.detail.blocks', 'Included blocks')}</h2>
        {c.inclusions && c.inclusions.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {c.inclusions
              .filter((inc) => inc.included)
              .map((inc) => (
                <li key={inc.id} className="flex items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-neutral-500 w-24">{inc.section}</span>
                  <span>{inc.block?.name || `Block ${inc.blockId}`}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            {t('contracts.detail.noBlocks', 'No blocks included.')}
          </p>
        )}
      </Card>
    </div>
  );
};

/**
 * Sub-component for the counter-sign card so its useEffect (which
 * needs the canvas to be in the DOM) only runs when the card is
 * actually mounted. Keeps the parent component readable.
 */
interface CountersignProps {
  name: string;
  setName: (v: string) => void;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  padRef: React.MutableRefObject<SignaturePad | null>;
  onSubmit: () => void;
  pending: boolean;
}

const CountersignCard: React.FC<CountersignProps> = ({
  name, setName, canvasRef, padRef, onSubmit, pending,
}) => {
  const { t } = useTranslation();

  // Initialise signature_pad once the canvas mounts. Same HiDPI
  // resize-on-mount trick the public sign page uses so strokes are
  // sharp on retina displays.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      const ctx = canvas.getContext('2d');
      ctx?.scale(ratio, ratio);
      padRef.current?.clear();
    };
    padRef.current = new SignaturePad(canvas, {
      penColor: '#111',
      backgroundColor: 'rgba(255, 255, 255, 0)',
    });
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      padRef.current?.off();
      padRef.current = null;
    };
  }, [canvasRef, padRef]);

  return (
    <Card padding="lg" className="mb-4">
      <h2 className="font-semibold mb-2">
        {t('contracts.detail.countersignTitle', 'Counter-sign to make it binding')}
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
        {t('contracts.detail.countersignHelp',
          'Type your name AND draw your signature below — both are stamped onto the re-rendered PDF. IP and timestamp are recorded for audit.')}
      </p>
      <div className="space-y-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('contracts.detail.signedNamePlaceholder', 'Your full name') as string}
          className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
        />
        <div>
          <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
            {t('contracts.detail.countersignSignaturePrompt', 'Draw your signature')}
          </label>
          <canvas
            ref={canvasRef}
            className="w-full h-32 bg-white rounded border border-neutral-300 dark:border-neutral-600 touch-none"
          />
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              onClick={() => padRef.current?.clear()}
              className="text-xs text-neutral-600 dark:text-neutral-400 hover:underline inline-flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              {t('contracts.detail.clearSignature', 'Clear')}
            </button>
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={onSubmit}
            disabled={!name.trim() || pending}
          >
            <CheckSquare className="w-4 h-4 mr-1" />
            {t('contracts.detail.confirmCountersign', 'Counter-sign')}
          </Button>
        </div>
      </div>
    </Card>
  );
};

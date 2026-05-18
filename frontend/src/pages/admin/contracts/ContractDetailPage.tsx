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
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  ArrowLeft, Edit2, Send, X, FileDown, Upload, CheckSquare, ScrollText,
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

  const [countersignName, setCountersignName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['contract', numericId],
    queryFn: () => contractsService.get(numericId as number),
    enabled: numericId !== null,
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
    mutationFn: () => contractsService.countersign(numericId as number, { name: countersignName }),
    onSuccess: () => {
      toast.success(t('contracts.detail.countersignedToast', 'Counter-signed.') as string);
      setCountersignName('');
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
    try {
      const url = await contractsService.pdfUrl(numericId);
      window.open(url, '_blank');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'PDF unavailable');
    }
  }

  async function handleSignedPdfDownload() {
    if (!numericId) return;
    try {
      const url = await contractsService.signedPdfUrl(numericId);
      window.open(url, '_blank');
    } catch (err: any) {
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

      {/* Counter-sign form */}
      {c.status === 'signed_by_customer' && !c.signedByAdminAt && (
        <Card padding="lg" className="mb-4">
          <h2 className="font-semibold mb-2">
            {t('contracts.detail.countersignTitle', 'Counter-sign to make it binding')}
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
            {t('contracts.detail.countersignHelp', 'Type your name as the issuer. We record IP and timestamp for audit. The PDF is re-rendered with both signature blocks filled in.')}
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={countersignName}
              onChange={(e) => setCountersignName(e.target.value)}
              placeholder={t('contracts.detail.signedNamePlaceholder', 'Your full name') as string}
              className="flex-1 px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
            />
            <Button
              onClick={() => countersignMutation.mutate()}
              disabled={!countersignName.trim() || countersignMutation.isPending}
            >
              <CheckSquare className="w-4 h-4 mr-1" />
              {t('contracts.detail.confirmCountersign', 'Counter-sign')}
            </Button>
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

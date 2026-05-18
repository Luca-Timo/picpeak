/**
 * Admin → Contract editor.
 *
 * Two modes:
 *   - /admin/clients/contracts/new       — create a fresh draft after
 *     picking a customer (server seeds inclusions from active system
 *     blocks).
 *   - /admin/clients/contracts/:id/edit  — edit an existing draft
 *     (scalars + block on/off + within-section ordering).
 *
 * Sent contracts can't be edited (locked at the service layer); admin
 * cancels + creates a fresh one for amendments.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Eye, Send, Save } from 'lucide-react';
import { Button, Card, Input, Loading } from '../../../components/common';
import {
  contractsService,
  type ContractBlockSection,
  type ContractDetail,
  CONTRACT_SECTIONS,
} from '../../../services/contracts.service';
import { customerAdminService } from '../../../services/customerAdmin.service';

interface BlockRow {
  blockId: number;
  section: ContractBlockSection;
  name: string;
  description: string | null;
  isSystem: boolean;
  included: boolean;
  position: number;
}

export const ContractEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);
  const numericId = id ? parseInt(id, 10) : null;

  const [customerAccountId, setCustomerAccountId] = useState<number | null>(null);
  // Customer label + passive flag mirror the QuoteEditorPage chip so
  // the admin sees the real name (company / first+last / display name)
  // and a "Passive — admin only" badge when the customer has no
  // portal access. Without these the chip would just say "#3".
  const [customerLabel, setCustomerLabel] = useState('');
  const [customerIsPassive, setCustomerIsPassive] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [title, setTitle] = useState('');
  const [introText, setIntroText] = useState('');
  const [outroText, setOutroText] = useState('');
  const [language, setLanguage] = useState('de');
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [validUntil, setValidUntil] = useState('');
  const [blocks, setBlocks] = useState<BlockRow[]>([]);

  // Load existing contract on edit.
  const { data: existing, isLoading: existingLoading } = useQuery({
    queryKey: ['contract', numericId],
    queryFn: () => contractsService.get(numericId as number),
    enabled: isEdit && numericId !== null,
  });

  // For new contracts, fetch every active block in the library so the
  // admin can opt-IN to non-system blocks (system blocks are pre-toggled
  // on by the server on create). We still show them all here for parity
  // with the edit flow.
  const { data: blockLibrary } = useQuery({
    queryKey: ['contracts', 'blocks-library'],
    queryFn: () => contractsService.listBlocks({ includeInactive: false }),
  });

  // Customer search (only for new-contract mode).
  const { data: customerOptions = [] } = useQuery({
    queryKey: ['customers-search', customerSearch],
    queryFn: () => customerAdminService.search(customerSearch),
    enabled: !isEdit && customerSearch.trim().length > 1,
  });

  // Hydrate state from server when the existing contract loads.
  useEffect(() => {
    if (!existing) return;
    const c = existing.contract;
    setCustomerAccountId(c.customerAccountId);
    setCustomerLabel(
      c.customer.companyName
      || [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ')
      || c.customer.displayName
      || c.customer.email
      || `#${c.customerAccountId}`,
    );
    // Backend transformContract doesn't currently surface isPassive
    // for contracts. Default to false; the chip just won't show the
    // badge in that case. (Quote/Bill detail compute this via the
    // customer.password_hash join — wire later if needed.)
    setCustomerIsPassive(false);
    setTitle(c.title || '');
    setIntroText(c.introText || '');
    setOutroText(c.outroText || '');
    setLanguage(c.language || 'de');
    setIssueDate(c.issueDate);
    setValidUntil(c.validUntil || '');
    setBlocks((c.inclusions || []).map((inc) => ({
      blockId: inc.blockId,
      section: inc.section,
      name: inc.block?.name || `Block ${inc.blockId}`,
      description: inc.block?.description ?? null,
      isSystem: inc.block?.isSystem === true,
      included: inc.included,
      position: inc.position,
    })));
  }, [existing]);

  // When creating new (no existing contract loaded yet), seed blocks
  // state from the library once it arrives so the admin can preview
  // the inclusion list before saving. The server will replace these
  // positions deterministically on create, but the UI shape matches.
  useEffect(() => {
    if (isEdit || !blockLibrary) return;
    if (blocks.length > 0) return;
    const rows: BlockRow[] = blockLibrary.blocks.map((b) => ({
      blockId: b.id,
      section: b.section,
      name: b.name,
      description: b.description,
      isSystem: b.isSystem,
      included: b.isSystem,                 // system blocks toggled on by default
      position: b.displayOrder,
    }));
    setBlocks(rows);
  }, [blockLibrary, isEdit, blocks.length]);

  const blocksBySection: Record<ContractBlockSection, BlockRow[]> = useMemo(() => {
    const out: Record<ContractBlockSection, BlockRow[]> = {
      basics: [], scope: [], privacy: [], commercial: [], nda: [], closing: [],
    };
    for (const b of blocks) out[b.section]?.push(b);
    for (const k of Object.keys(out) as ContractBlockSection[]) {
      out[k].sort((a, b) => a.position - b.position);
    }
    return out;
  }, [blocks]);

  function toggleBlock(blockId: number) {
    setBlocks((cur) => cur.map((b) => b.blockId === blockId ? { ...b, included: !b.included } : b));
  }

  function moveBlock(blockId: number, delta: -1 | 1) {
    setBlocks((cur) => {
      const idx = cur.findIndex((b) => b.blockId === blockId);
      if (idx < 0) return cur;
      const target = cur[idx];
      const siblings = cur.filter((b) => b.section === target.section).sort((a, b) => a.position - b.position);
      const sib = siblings.findIndex((b) => b.blockId === blockId);
      const next = sib + delta;
      if (next < 0 || next >= siblings.length) return cur;
      const swap = siblings[next];
      return cur.map((b) => {
        if (b.blockId === target.blockId) return { ...b, position: swap.position };
        if (b.blockId === swap.blockId)   return { ...b, position: target.position };
        return b;
      });
    });
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!customerAccountId) throw new Error('Pick a customer first');
      const created = await contractsService.create({
        customerAccountId,
        language,
        title: title || null,
        introText: introText || null,
        outroText: outroText || null,
        issueDate,
        validUntil: validUntil || undefined,
      });
      // Apply block toggles + ordering as an update right after create.
      await contractsService.update(created.contract.id, {
        blocks: blocks.map((b) => ({
          blockId: b.blockId, included: b.included, position: b.position,
        })),
      });
      return created.contract;
    },
    onSuccess: (created) => {
      toast.success(t('contracts.editor.createdToast', 'Contract created.') as string);
      navigate(`/admin/clients/contracts/${created.id}`);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || err?.message || t('contracts.editor.saveError', 'Save failed') as string);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!numericId) return;
      await contractsService.update(numericId, {
        title: title || null,
        introText: introText || null,
        outroText: outroText || null,
        language,
        issueDate,
        validUntil: validUntil || undefined,
        blocks: blocks.map((b) => ({
          blockId: b.blockId, included: b.included, position: b.position,
        })),
      });
    },
    onSuccess: () => {
      toast.success(t('contracts.editor.savedToast', 'Contract saved.') as string);
      navigate(`/admin/clients/contracts/${numericId}`);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || err?.message || t('contracts.editor.saveError', 'Save failed') as string);
    },
  });

  async function handlePreview() {
    // For new contracts, we'd need to create first to preview; keep it
    // simple — disable preview before save.
    if (!isEdit || !numericId) {
      toast.info(t('contracts.editor.previewAfterSave', 'Save the draft first, then preview.') as string);
      return;
    }
    // Sync-open the placeholder window BEFORE any await so the popup
    // blocker treats this as a user gesture, then redirect once the
    // blob URL is ready. Same pattern bills/quotes use.
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('contracts.editor.popupBlocked', 'Allow pop-ups for this site to preview the PDF.') as string);
      return;
    }
    try {
      const url = await contractsService.previewPdfUrl(numericId);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || t('contracts.editor.previewError', 'Preview failed') as string);
    }
  }

  if (isEdit && existingLoading) return <Loading />;
  if (isEdit && existing && existing.contract.status !== 'draft') {
    return (
      <Card padding="lg">
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {t('contracts.editor.locked', 'Sent contracts cannot be edited. Cancel and create a fresh one for amendments.')}
        </p>
        <div className="mt-3">
          <Link to={`/admin/clients/contracts/${numericId}`} className="text-accent-dark hover:underline">
            ← {t('contracts.editor.backToDetail', 'Back to contract')}
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link
          to="/admin/clients/contracts"
          className="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:text-accent-dark"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('contracts.editor.back', 'Back to list')}
        </Link>
        <h1 className="text-2xl font-bold flex-1">
          {isEdit
            ? t('contracts.editor.titleEdit', 'Edit contract')
            : t('contracts.editor.titleNew', 'New contract')}
        </h1>
        {isEdit && (
          <Button variant="outline" onClick={handlePreview}>
            <Eye className="w-4 h-4 mr-1" />
            {t('contracts.editor.preview', 'Preview PDF')}
          </Button>
        )}
        <Button
          onClick={() => isEdit ? updateMutation.mutate() : createMutation.mutate()}
          disabled={
            (createMutation.isPending || updateMutation.isPending)
            || (!isEdit && !customerAccountId)
          }
        >
          <Save className="w-4 h-4 mr-1" />
          {isEdit
            ? t('contracts.editor.save', 'Save')
            : t('contracts.editor.create', 'Create draft')}
        </Button>
      </div>

      {/* Scalars */}
      <Card padding="lg" className="mb-4">
        {!isEdit && (
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.customer', 'Customer')}
            </label>
            {customerAccountId ? (
              <div className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-800 rounded-md px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm">{customerLabel || `#${customerAccountId}`}</span>
                  {customerIsPassive && (
                    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300">
                      {t('customers.passive.badge', 'Passive — admin only')}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="text-sm text-accent-dark hover:underline"
                  onClick={() => { setCustomerAccountId(null); setCustomerLabel(''); setCustomerIsPassive(false); }}
                >
                  {t('contracts.editor.changeCustomer', 'Change')}
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder={t('contracts.editor.searchCustomer', 'Search by email…') as string}
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                />
                {customerOptions.length > 0 && (
                  <ul className="mt-2 border border-neutral-200 dark:border-neutral-700 rounded max-h-48 overflow-y-auto text-sm">
                    {customerOptions.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setCustomerAccountId(c.id);
                            setCustomerLabel(
                              c.companyName
                              || [c.firstName, c.lastName].filter(Boolean).join(' ')
                              || c.displayName
                              || c.email
                              || `#${c.id}`,
                            );
                            setCustomerIsPassive(Boolean(c.isPassive));
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        >
                          {c.displayName || c.email} {c.companyName ? `(${c.companyName})` : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.titleField', 'Contract title')}
            </label>
            <Input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('contracts.editor.titlePlaceholder', 'e.g. Wedding contract Doe / Müller') as string}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.language', 'Language')}
            </label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.issueDate', 'Issue date')}
            </label>
            <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.validUntil', 'Sign by (optional)')}
            </label>
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </div>
        </div>

        <div className="mt-3">
          <label className="block text-sm font-medium mb-1">
            {t('contracts.editor.intro', 'Intro text (optional)')}
          </label>
          <textarea
            value={introText}
            onChange={(e) => setIntroText(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
          />
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium mb-1">
            {t('contracts.editor.outro', 'Closing text (optional)')}
          </label>
          <textarea
            value={outroText}
            onChange={(e) => setOutroText(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
          />
        </div>
      </Card>

      {/* Disclaimer banner */}
      <div className="mb-4 p-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200">
        <p className="font-medium mb-1">
          {t('contracts.editor.disclaimerTitle', 'Lawyer review required')}
        </p>
        <p className="text-xs">
          {t('contracts.editor.disclaimerBody', 'The seeded block bodies are EXAMPLES ONLY — written by the maintainer, not by a lawyer. Have your own lawyer review every block you include before sending the contract. See docs/crm-disclaimers.md.')}
        </p>
      </div>

      {/* Block accordions */}
      {CONTRACT_SECTIONS.map((section) => (
        <Card key={section} padding="lg" className="mb-3">
          <h2 className="text-lg font-semibold mb-2">
            {t(`contracts.sections.${section}`, section)}
          </h2>
          {blocksBySection[section].length === 0 ? (
            <p className="text-sm text-neutral-500">
              {t('contracts.editor.noBlocksInSection', 'No blocks for this section yet.')}
            </p>
          ) : (
            <ul className="space-y-2">
              {blocksBySection[section].map((b) => (
                <li
                  key={b.blockId}
                  className="flex items-start gap-3 p-2 rounded border border-neutral-200 dark:border-neutral-700"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={b.included}
                    onChange={() => toggleBlock(b.blockId)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{b.name}</span>
                      {b.isSystem && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700">
                          {t('contracts.editor.systemBadge', 'System')}
                        </span>
                      )}
                    </div>
                    {b.description && (
                      <p className="text-xs text-neutral-500 mt-1">{b.description}</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      className="px-2 py-0.5 text-xs rounded border border-neutral-300 dark:border-neutral-600"
                      onClick={() => moveBlock(b.blockId, -1)}
                    >↑</button>
                    <button
                      type="button"
                      className="px-2 py-0.5 text-xs rounded border border-neutral-300 dark:border-neutral-600"
                      onClick={() => moveBlock(b.blockId, 1)}
                    >↓</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
};

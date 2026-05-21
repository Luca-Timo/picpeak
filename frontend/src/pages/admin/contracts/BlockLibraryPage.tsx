/**
 * Admin → Contract block library.
 *
 * Two-column layout (modelled on EmailConfigPage):
 *   - Left sidebar: "+ New block" button at the top, then blocks
 *     grouped by section. Active blocks render bright; inactive
 *     dim with opacity-50. System blocks carry a small badge.
 *   - Right panel: editor for the currently-selected block (or the
 *     new-block form when "+ New block" was clicked). EN/DE bodies
 *     swap via a language tab inside the editor; the active toggle
 *     fires an update immediately on flip.
 *
 * Admin can:
 *   - Edit any block (body text fully editable for system blocks too,
 *     so the lawyer-reviewed version replaces the seeded example in
 *     place)
 *   - Toggle blocks active/inactive
 *   - Create new admin-authored blocks
 *   - Delete admin-authored blocks (system blocks refuse delete)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import {
  contractsService,
  type ContractBlock,
  type ContractBlockSection,
  CONTRACT_SECTIONS,
} from '../../../services/contracts.service';

type Selection =
  | { mode: 'new' }
  | { mode: 'edit'; block: ContractBlock }
  | null;

export const BlockLibraryPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Selection>(null);
  const [showInactive, setShowInactive] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['contracts', 'blocks', { showInactive }],
    queryFn: () => contractsService.listBlocks({ includeInactive: showInactive }),
  });

  const blocks = data?.blocks || [];

  // Keep the selected edit-block fresh after a save so the editor
  // reflects what the server actually persisted (e.g. trimmed name,
  // server-set timestamps). Selection by id is stable across reloads.
  useEffect(() => {
    if (selected?.mode !== 'edit') return;
    const refreshed = blocks.find((b) => b.id === selected.block.id);
    if (refreshed && refreshed !== selected.block) {
      setSelected({ mode: 'edit', block: refreshed });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  const grouped: Record<ContractBlockSection, ContractBlock[]> = useMemo(() => {
    const g: Record<ContractBlockSection, ContractBlock[]> = {
      basics: [], scope: [], privacy: [], commercial: [], nda: [], closing: [],
    };
    for (const b of blocks) g[b.section]?.push(b);
    return g;
  }, [blocks]);

  const createMutation = useMutation({
    mutationFn: (payload: any) => contractsService.createBlock(payload),
    onSuccess: (res) => {
      toast.success(t('contracts.blocks.createdToast', 'Block created.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
      if (res?.block) setSelected({ mode: 'edit', block: res.block });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.createError', 'Create failed') as string),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: any }) => contractsService.updateBlock(id, payload),
    onSuccess: (res) => {
      toast.success(t('contracts.blocks.updatedToast', 'Block updated.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
      if (res?.block && selected?.mode === 'edit') {
        setSelected({ mode: 'edit', block: res.block });
      }
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.updateError', 'Update failed') as string),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => contractsService.deleteBlock(id),
    onSuccess: () => {
      toast.success(t('contracts.blocks.deletedToast', 'Block deleted.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
      setSelected(null);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.deleteError', 'Delete failed') as string),
  });

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Link
          to="/admin/clients/contracts"
          className="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:text-accent-dark"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('contracts.blocks.back', 'Back to contracts')}
        </Link>
        <h1 className="text-2xl font-bold flex-1">
          {t('contracts.blocks.title', 'Contract block library')}
        </h1>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t('contracts.blocks.showInactive', 'Show inactive')}
        </label>
      </div>

      {/* Disclaimer banner */}
      <div className="mb-4 p-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200">
        <p className="font-medium mb-1">
          {t('contracts.blocks.disclaimerTitle', 'Examples only — have your lawyer review')}
        </p>
        <p className="text-xs">
          {t(
            'contracts.blocks.disclaimerBody',
            'The 12 seeded "System" blocks are written by the picpeak maintainer, not by a lawyer. They are intended as starting points only — review and adapt every block you intend to send with your own lawyer. Edits to system blocks are persisted; replace the seeded body text with the lawyer-reviewed version in place. See docs/crm-disclaimers.md.',
          )}
        </p>
      </div>

      {isLoading ? <Loading /> : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* Left column — sidebar list */}
          <Card padding="sm" className="self-start">
            <Button
              variant={selected?.mode === 'new' ? 'primary' : 'outline'}
              onClick={() => setSelected({ mode: 'new' })}
              className="mb-3 w-full"
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('contracts.blocks.new', 'New block')}
            </Button>

            <div className="space-y-5">
              {CONTRACT_SECTIONS.map((section) => (
                <div key={section}>
                  <h4 className="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    {t(`contracts.sections.${section}`, section)}
                  </h4>
                  {grouped[section].length === 0 ? (
                    <p className="px-1 text-xs text-neutral-400 dark:text-neutral-500">
                      {t('contracts.blocks.empty', 'No blocks in this section.')}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {grouped[section].map((b) => {
                        const isSelected = selected?.mode === 'edit' && selected.block.id === b.id;
                        return (
                          <button
                            type="button"
                            key={b.id}
                            onClick={() => setSelected({ mode: 'edit', block: b })}
                            className={`w-full text-left p-2 rounded-md border transition-colors ${
                              isSelected
                                ? 'border-accent bg-accent/10 dark:bg-accent/20'
                                : b.isActive
                                  ? 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                                  : 'border-neutral-200 dark:border-neutral-700 opacity-50 hover:opacity-75'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-medium text-sm truncate">{b.name}</span>
                              {b.isSystem && (
                                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700">
                                  {t('contracts.blocks.systemBadge', 'System')}
                                </span>
                              )}
                              {!b.isActive && (
                                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                                  {t('contracts.blocks.inactive', 'Inactive')}
                                </span>
                              )}
                            </div>
                            {b.description && (
                              <p className="text-xs text-neutral-500 mt-1 truncate">{b.description}</p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {/* Right column — editor for the selected block (or the
              new-block form when "+ New" was clicked) */}
          <Card padding="lg">
            {selected === null ? (
              <p className="text-sm text-neutral-500">
                {t('contracts.blocks.selectPrompt', 'Select a block on the left, or click "+ New block" to create one.')}
              </p>
            ) : (
              <BlockEditor
                key={selected.mode === 'edit' ? `edit-${selected.block.id}` : 'new'}
                selection={selected}
                onSave={(payload) => {
                  if (selected.mode === 'new') {
                    createMutation.mutate(payload);
                  } else {
                    updateMutation.mutate({ id: selected.block.id, payload });
                  }
                }}
                onToggleActive={(next) => {
                  if (selected.mode === 'edit') {
                    updateMutation.mutate({
                      id: selected.block.id,
                      payload: { isActive: next },
                    });
                  }
                }}
                onDelete={() => {
                  if (
                    selected.mode === 'edit'
                    && window.confirm(t('contracts.blocks.deleteConfirm', 'Delete this block?') as string)
                  ) {
                    deleteMutation.mutate(selected.block.id);
                  }
                }}
                pending={createMutation.isPending || updateMutation.isPending || deleteMutation.isPending}
              />
            )}
          </Card>
        </div>
      )}
    </div>
  );
};

interface EditorProps {
  selection: Exclude<Selection, null>;
  onSave: (payload: any) => void;
  onToggleActive: (next: boolean) => void;
  onDelete: () => void;
  pending: boolean;
}

const BlockEditor: React.FC<EditorProps> = ({ selection, onSave, onToggleActive, onDelete, pending }) => {
  const { t } = useTranslation();
  const b = selection.mode === 'edit' ? selection.block : null;

  const [section, setSection] = useState<ContractBlockSection>(b?.section ?? 'basics');
  const [name, setName] = useState(b?.name ?? '');
  const [description, setDescription] = useState(b?.description ?? '');
  const [bodyText, setBodyText] = useState(b?.bodyText ?? '');
  const [bodyTextDe, setBodyTextDe] = useState(b?.bodyTextDe ?? '');
  const [bodyLang, setBodyLang] = useState<'en' | 'de'>('en');

  const isSystem = !!b?.isSystem;
  const isActive = b?.isActive ?? true;
  const canSave = name.trim().length > 0 && bodyText.trim().length > 0;

  return (
    <div>
      <h3 className="font-semibold mb-3">
        {selection.mode === 'new'
          ? t('contracts.blocks.dialog.createTitle', 'New block')
          : t('contracts.blocks.dialog.editTitle', 'Edit block')}
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-sm font-medium mb-1">
            {t('contracts.blocks.dialog.section', 'Section')}
          </label>
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as ContractBlockSection)}
            disabled={isSystem}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm disabled:opacity-50"
          >
            {CONTRACT_SECTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            {t('contracts.blocks.dialog.name', 'Name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
          />
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-sm font-medium mb-1">
          {t('contracts.blocks.dialog.description', 'Description (admin hint)')}
        </label>
        <input
          type="text"
          value={description ?? ''}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
        />
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-sm font-medium">
            {t('contracts.blocks.dialog.body', 'Body')}
          </label>
          <div className="flex rounded-md border border-neutral-300 dark:border-neutral-600 overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setBodyLang('en')}
              className={`px-3 py-1 ${
                bodyLang === 'en'
                  ? 'bg-accent text-white'
                  : 'bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700'
              }`}
            >
              {t('contracts.blocks.dialog.langEn', 'English')}
            </button>
            <button
              type="button"
              onClick={() => setBodyLang('de')}
              className={`px-3 py-1 border-l border-neutral-300 dark:border-neutral-600 ${
                bodyLang === 'de'
                  ? 'bg-accent text-white'
                  : 'bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700'
              }`}
            >
              {t('contracts.blocks.dialog.langDe', 'German')}
            </button>
          </div>
        </div>
        {bodyLang === 'en' ? (
          <textarea
            rows={8}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm font-mono"
          />
        ) : (
          <textarea
            rows={8}
            value={bodyTextDe ?? ''}
            onChange={(e) => setBodyTextDe(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm font-mono"
          />
        )}
      </div>

      <p className="text-xs text-neutral-500 mb-3">
        {t(
          'contracts.blocks.dialog.placeholderHint',
          'You can use {{customer_name}}, {{event_name}}, {{event_date}}, {{net_days}}, {{skonto_percent}}, {{skonto_within_days}}, {{cancellation_30d_percent}}, {{currency}}, {{issuer_company_name}}, {{issuer_address}}, {{contract_number}}, {{source_quote_number}} as placeholders — substituted when the contract is rendered.',
        )}
      </p>

      {/* Active toggle — only shown in edit mode; flip fires an
          update immediately. In new mode the block is created active
          by default on the server. */}
      {selection.mode === 'edit' && (
        <label className="flex items-center gap-2 text-sm mb-4 select-none">
          <input
            type="checkbox"
            checked={isActive}
            disabled={pending}
            onChange={(e) => onToggleActive(e.target.checked)}
          />
          <span className="font-medium">
            {t('contracts.blocks.dialog.active', 'Active')}
          </span>
          <span className="text-xs text-neutral-500">
            {isActive
              ? t('contracts.blocks.dialog.activeHint', 'Available to be added to contracts.')
              : t('contracts.blocks.dialog.inactiveHint', 'Hidden from the contract editor.')}
          </span>
        </label>
      )}

      <div className="flex justify-between gap-2 flex-wrap">
        <div>
          {selection.mode === 'edit' && !isSystem && (
            <Button
              variant="outline"
              onClick={onDelete}
              disabled={pending}
              className="text-red-600 border-red-300 hover:bg-red-50"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {t('contracts.blocks.dialog.delete', 'Delete')}
            </Button>
          )}
        </div>
        <Button
          disabled={pending || !canSave}
          onClick={() => onSave({
            section,
            name: name.trim(),
            description: description?.trim() || null,
            bodyText,
            bodyTextDe: bodyTextDe?.trim() ? bodyTextDe : null,
          })}
        >
          {selection.mode === 'new'
            ? t('contracts.blocks.dialog.create', 'Create')
            : t('contracts.blocks.dialog.save', 'Save')}
        </Button>
      </div>
    </div>
  );
};

/**
 * Admin → Contract block library.
 *
 * Lists every block in `contract_blocks` grouped by section. Admin can:
 *   - Edit any block (body text fully editable for system blocks too,
 *     so the lawyer-reviewed version replaces the seeded example in
 *     place)
 *   - Toggle blocks active/inactive
 *   - Create new admin-authored blocks
 *   - Delete admin-authored blocks (system blocks refuse delete)
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Plus, Edit2, Trash2, Power } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import {
  contractsService,
  type ContractBlock,
  type ContractBlockSection,
  CONTRACT_SECTIONS,
} from '../../../services/contracts.service';

interface EditorState {
  mode: 'create' | 'edit';
  block?: ContractBlock;
}

export const BlockLibraryPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['contracts', 'blocks', { showInactive }],
    queryFn: () => contractsService.listBlocks({ includeInactive: showInactive }),
  });

  const createMutation = useMutation({
    mutationFn: (payload: any) => contractsService.createBlock(payload),
    onSuccess: () => {
      toast.success(t('contracts.blocks.createdToast', 'Block created.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
      setEditor(null);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.createError', 'Create failed') as string),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: any }) => contractsService.updateBlock(id, payload),
    onSuccess: () => {
      toast.success(t('contracts.blocks.updatedToast', 'Block updated.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
      setEditor(null);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.updateError', 'Update failed') as string),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => contractsService.deleteBlock(id),
    onSuccess: () => {
      toast.success(t('contracts.blocks.deletedToast', 'Block deleted.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.deleteError', 'Delete failed') as string),
  });

  const blocks = data?.blocks || [];
  const grouped: Record<ContractBlockSection, ContractBlock[]> = {
    basics: [], scope: [], privacy: [], commercial: [], nda: [], closing: [],
  };
  for (const b of blocks) grouped[b.section]?.push(b);

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
        <Button onClick={() => setEditor({ mode: 'create' })}>
          <Plus className="w-4 h-4 mr-1" />
          {t('contracts.blocks.new', 'New block')}
        </Button>
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
        CONTRACT_SECTIONS.map((section) => (
          <Card key={section} padding="lg" className="mb-3">
            <h2 className="text-lg font-semibold mb-2">
              {t(`contracts.sections.${section}`, section)}
            </h2>
            {grouped[section].length === 0 ? (
              <p className="text-sm text-neutral-500">
                {t('contracts.blocks.empty', 'No blocks in this section.')}
              </p>
            ) : (
              <ul className="space-y-2">
                {grouped[section].map((b) => (
                  <li
                    key={b.id}
                    className={`p-2 rounded border border-neutral-200 dark:border-neutral-700 ${
                      !b.isActive ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="flex items-start gap-2 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{b.name}</span>
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
                          <p className="text-xs text-neutral-500 mt-1">{b.description}</p>
                        )}
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <button
                          type="button"
                          title={t('contracts.blocks.edit', 'Edit') as string}
                          onClick={() => setEditor({ mode: 'edit', block: b })}
                          className="p-1.5 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          title={b.isActive ? t('contracts.blocks.deactivate', 'Deactivate') as string : t('contracts.blocks.activate', 'Activate') as string}
                          onClick={() => updateMutation.mutate({ id: b.id, payload: { isActive: !b.isActive } })}
                          className="p-1.5 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        >
                          <Power className="w-4 h-4" />
                        </button>
                        {!b.isSystem && (
                          <button
                            type="button"
                            title={t('contracts.blocks.delete', 'Delete') as string}
                            onClick={() => {
                              if (window.confirm(t('contracts.blocks.deleteConfirm', 'Delete this block?') as string)) {
                                deleteMutation.mutate(b.id);
                              }
                            }}
                            className="p-1.5 rounded border border-red-300 text-red-600 hover:bg-red-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))
      )}

      {editor && (
        <BlockEditorDialog
          state={editor}
          onCancel={() => setEditor(null)}
          onSubmit={(payload) => {
            if (editor.mode === 'create') createMutation.mutate(payload);
            else if (editor.block) updateMutation.mutate({ id: editor.block.id, payload });
          }}
          pending={createMutation.isPending || updateMutation.isPending}
        />
      )}
    </div>
  );
};

interface DialogProps {
  state: EditorState;
  onCancel: () => void;
  onSubmit: (payload: any) => void;
  pending: boolean;
}

const BlockEditorDialog: React.FC<DialogProps> = ({ state, onCancel, onSubmit, pending }) => {
  const { t } = useTranslation();
  const b = state.block;
  const [section, setSection] = useState<ContractBlockSection>(b?.section ?? 'basics');
  const [name, setName] = useState(b?.name ?? '');
  const [description, setDescription] = useState(b?.description ?? '');
  const [bodyText, setBodyText] = useState(b?.bodyText ?? '');
  const [bodyTextDe, setBodyTextDe] = useState(b?.bodyTextDe ?? '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-3xl bg-white dark:bg-neutral-900 rounded-lg shadow-xl p-4 mt-8">
        <h3 className="font-semibold mb-3">
          {state.mode === 'create'
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
              disabled={b?.isSystem}
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
          <label className="block text-sm font-medium mb-1">
            {t('contracts.blocks.dialog.bodyEn', 'Body (English)')}
          </label>
          <textarea
            rows={8}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm font-mono"
          />
        </div>

        <div className="mb-3">
          <label className="block text-sm font-medium mb-1">
            {t('contracts.blocks.dialog.bodyDe', 'Body (German, optional)')}
          </label>
          <textarea
            rows={8}
            value={bodyTextDe ?? ''}
            onChange={(e) => setBodyTextDe(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm font-mono"
          />
        </div>

        <p className="text-xs text-neutral-500 mb-3">
          {t(
            'contracts.blocks.dialog.placeholderHint',
            'You can use {{customer_name}}, {{event_name}}, {{event_date}}, {{net_days}}, {{skonto_percent}}, {{skonto_within_days}}, {{cancellation_30d_percent}}, {{currency}}, {{issuer_company_name}}, {{issuer_address}}, {{contract_number}} as placeholders — substituted when the contract is rendered.',
          )}
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t('contracts.blocks.dialog.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={pending || !name.trim() || !bodyText.trim()}
            onClick={() => onSubmit({
              section,
              name: name.trim(),
              description: description?.trim() || null,
              bodyText,
              bodyTextDe: bodyTextDe?.trim() ? bodyTextDe : null,
            })}
          >
            {state.mode === 'create'
              ? t('contracts.blocks.dialog.create', 'Create')
              : t('contracts.blocks.dialog.save', 'Save')}
          </Button>
        </div>
      </div>
    </div>
  );
};

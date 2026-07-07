import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  Inbox, Send, Reply, ReplyAll, Forward, Archive, Trash2, Paperclip,
  FileText, Quote, FileSignature, Image as ImageIcon, ReceiptText,
  Link2, X, ChevronLeft, ChevronRight, Mail, RefreshCw, PenSquare, type LucideIcon,
} from 'lucide-react';
import { emailService, type ReceivedEmail, type MailIdentities } from '../../../services/email.service';
import { accountingService } from '../../../services/accounting.service';
import { Loading } from '../../../components/common';
import { MessageComposer, type ComposerInit } from './MessageComposer';

/**
 * Admin "Messages" — read-only viewer over the mail picpeak already
 * has: the Automated stream (email_queue, incl. rendered bodies from migration
 * 119) and the Accounting inbox (received_emails / supplier invoices). The
 * Customers (hello@) mailbox and reply/compose land in later phases; those
 * folders render an explanatory empty state so the full IA is visible now.
 */

type FolderSrc = 'queue' | 'received' | 'empty';
interface Folder { id: string; name: string; icon: LucideIcon; src: FolderSrc; account?: string; origin?: 'system' | 'manual'; note?: string; }
interface Account { id: string; name: string; addr?: string; color: string; folders: Folder[]; }

type Selection =
  | { kind: 'queue'; id: number }
  | { kind: 'received'; item: ReceivedEmail }
  | null;

const TYPE_LABELS: Record<string, string> = {
  invoice_sent: 'Invoice sent',
  invoice_reminder_first: 'Payment reminder',
  invoice_reminder_second: 'Payment reminder',
  invoice_reminder_final: 'Final reminder',
  invoice_payment_check: 'Payment check',
  invoice_collections_handoff: 'Collections handoff',
  invoice_paid_admin_notification: 'Payment received',
  expiration_warning: 'Gallery expiring',
  gallery_expired: 'Gallery expired',
  quote_sent: 'Quote sent',
  contract_sent: 'Contract sent',
};
const friendlyType = (t: string) =>
  TYPE_LABELS[t] || t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

const STATUS_STYLES: Record<string, string> = {
  sent: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  ingested: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  received: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

export const MessagesPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [activeFolder, setActiveFolder] = useState('auto-sent');
  const [selection, setSelection] = useState<Selection>(null);
  const [pdfDocId, setPdfDocId] = useState<number | null>(null);
  const [composer, setComposer] = useState<{ init: ComposerInit; title?: string; accountKey?: string } | null>(null);

  // "Sync" = poll the inbound mailboxes now instead of waiting for the 60s loop.
  const sync = useMutation({
    mutationFn: () => emailService.pollIncoming(),
    onSuccess: (r) => {
      if (r.skipped === 'disabled') toast.info(t('messages.syncDisabled', 'Incoming mail is off — enable it under Settings → Features.'));
      else if (r.skipped === 'unconfigured') toast.info(t('messages.syncUnconfigured', 'Configure a mailbox under Settings → Email first.'));
      else if (r.skipped === 'busy') toast.info(t('messages.syncBusy', 'A sync is already running.'));
      else toast.success(t('messages.syncOk', 'Checked mailboxes — {{count}} new.', { count: r.processed || 0 }));
      acctQuery.refetch(); custQuery.refetch(); queueQuery.refetch();
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('messages.syncFailed', 'Sync failed.')),
  });

  const openNewMessage = () => setComposer({
    init: { to: '', subject: '', html: '' },
    title: t('messages.newMessage', 'New message'),
    accountKey: 'customers',
  });

  const queueQuery = useQuery({
    queryKey: ['messages', 'queue'],
    queryFn: () => emailService.listQueue({ pageSize: 100 }),
    refetchInterval: 60000,
  });
  const acctQuery = useQuery({
    queryKey: ['messages', 'received', 'accounting'],
    queryFn: () => emailService.listReceived({ account: 'accounting', pageSize: 100 }),
    refetchInterval: 60000,
  });
  const custQuery = useQuery({
    queryKey: ['messages', 'received', 'customers'],
    queryFn: () => emailService.listReceived({ account: 'customers', pageSize: 100 }),
    refetchInterval: 60000,
  });

  const identitiesQuery = useQuery({
    queryKey: ['messages', 'identities'],
    queryFn: () => emailService.getIdentities(),
  });
  const identities = identitiesQuery.data;

  const queueTotal = queueQuery.data?.pagination.total;
  const acctTotal = acctQuery.data?.pagination.total;
  const custTotal = custQuery.data?.pagination.total;

  const accounts: Account[] = useMemo(() => [
    { id: 'all', name: t('messages.account.all', 'All mail'), color: '#64748b', folders: [
      { id: 'all-in', name: t('messages.folder.inbox', 'Inbox'), icon: Inbox, src: 'received' },
      { id: 'all-sent', name: t('messages.folder.sent', 'Sent'), icon: Send, src: 'queue' },
    ] },
    { id: 'cust', name: t('messages.account.customers', 'Customers'), addr: identities?.customers || undefined, color: '#2563c9', folders: [
      { id: 'cust-in', name: t('messages.folder.inbox', 'Inbox'), icon: Inbox, src: 'received', account: 'customers' },
      { id: 'cust-sent', name: t('messages.folder.sent', 'Sent'), icon: Send, src: 'queue', origin: 'manual' },
    ] },
    { id: 'acct', name: t('messages.account.accounting', 'Accounting'), addr: identities?.accounting || undefined, color: '#12876a', folders: [
      { id: 'acct-in', name: t('messages.folder.inbox', 'Inbox'), icon: Inbox, src: 'received', account: 'accounting' },
    ] },
    { id: 'auto', name: t('messages.account.automated', 'Automated'), addr: identities?.automated || undefined, color: '#7a52d6', folders: [
      { id: 'auto-sent', name: t('messages.folder.sent', 'Sent'), icon: Send, src: 'queue', origin: 'system' },
    ] },
  ], [t, identities]);

  // Sent stream is split client-side by origin: system (Automated) vs manual
  // (human composed → Customers ▸ Sent). Legacy rows (origin undefined) = system.
  const queueItemsAll = queueQuery.data?.items || [];
  const queueFor = (origin?: 'system' | 'manual') =>
    origin === 'manual' ? queueItemsAll.filter((i) => i.origin === 'manual')
      : origin === 'system' ? queueItemsAll.filter((i) => i.origin !== 'manual')
        : queueItemsAll;

  const folder = useMemo(() => {
    for (const a of accounts) for (const f of a.folders) if (f.id === activeFolder) return { a, f };
    return { a: accounts[0], f: accounts[0].folders[0] };
  }, [accounts, activeFolder]);

  const countFor = (f: Folder): number | undefined => {
    if (f.src === 'queue') return f.origin ? queueFor(f.origin).length : queueTotal;
    if (f.src === 'received') {
      if (f.account === 'customers') return custTotal;
      if (f.account === 'accounting') return acctTotal;
      return (acctTotal || 0) + (custTotal || 0);
    }
    return undefined;
  };

  // Which received rows feed the active folder (customer / accounting / union).
  const receivedItems = useMemo(() => {
    if (folder.f.src !== 'received') return undefined;
    const a = acctQuery.data?.items || [];
    const c = custQuery.data?.items || [];
    if (folder.f.account === 'customers') return c;
    if (folder.f.account === 'accounting') return a;
    return [...a, ...c].sort((x, y) => (y.received_at || '').localeCompare(x.received_at || ''));
  }, [folder, acctQuery.data, custQuery.data]);

  const receivedLoading = folder.f.account === 'customers'
    ? custQuery.isLoading
    : folder.f.account === 'accounting'
      ? acctQuery.isLoading
      : acctQuery.isLoading || custQuery.isLoading;

  return (
    <div className="flex flex-col h-[calc(100vh-8.5rem)] min-h-[540px]">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <Mail className="w-6 h-6 text-neutral-500 dark:text-neutral-400" />
            {t('messages.title', 'Messages')}
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-0.5">
            {t('messages.subtitle', 'Sent, automated and incoming mail — one place.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-neutral-300 dark:border-neutral-700 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${sync.isPending ? 'animate-spin' : ''}`} />
            {t('messages.sync', 'Sync')}
          </button>
          <button
            onClick={openNewMessage}
            className="inline-flex items-center gap-2 h-9 px-3.5 rounded-lg bg-accent-dark text-white text-sm font-medium hover:opacity-90"
          >
            <PenSquare className="w-4 h-4" />
            {t('messages.newMessage', 'New message')}
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden bg-white dark:bg-neutral-900">
        {/* ── account tree ── */}
        <nav className="w-56 flex-none border-r border-neutral-200 dark:border-neutral-800 overflow-y-auto p-2 bg-neutral-50 dark:bg-neutral-950/40">
          {accounts.map((a) => (
            <div key={a.id} className="mb-1.5">
              <div className="flex items-center gap-2 px-2 py-1.5 text-sm font-semibold text-neutral-800 dark:text-neutral-200">
                <span className="w-2 h-2 rounded-full flex-none" style={{ background: a.color }} />
                <span>{a.name}</span>
                {a.addr && <span className="ml-auto text-[11px] font-medium font-mono text-neutral-400 dark:text-neutral-500">{a.addr}</span>}
              </div>
              <div className="flex flex-col gap-0.5">
                {a.folders.map((f) => {
                  const c = countFor(f);
                  const active = f.id === activeFolder;
                  return (
                    <button
                      key={f.id}
                      onClick={() => { setActiveFolder(f.id); setSelection(null); }}
                      className={`flex items-center gap-2 pl-7 pr-2 py-1.5 rounded-lg text-[13.5px] text-left transition-colors ${
                        active
                          ? 'bg-accent-soft text-on-accent-soft font-semibold'
                          : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
                      }`}
                    >
                      <f.icon className="w-4 h-4 opacity-80" />
                      <span>{f.name}</span>
                      {typeof c === 'number' && c > 0 && (
                        <span className={`ml-auto tabular-nums text-xs ${active ? 'text-on-accent-soft' : 'text-neutral-400'}`}>{c}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* ── message list ── */}
        <section className="w-[22rem] flex-none flex flex-col min-h-0 border-r border-neutral-200 dark:border-neutral-800">
          <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex-none">
            <div className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{folder.f.name}</div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              {folder.a.addr || (folder.a.id === 'all' ? t('messages.unified', 'Unified across accounts') : t('messages.systemGenerated', 'System-generated'))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <MessageList
              folder={folder.f}
              queue={queueFor(folder.f.origin)}
              received={receivedItems}
              loading={folder.f.src === 'queue' ? queueQuery.isLoading : folder.f.src === 'received' ? receivedLoading : false}
              selection={selection}
              onSelect={setSelection}
              t={t}
            />
          </div>
        </section>

        {/* ── reading pane ── */}
        <section className="flex-1 min-w-0 flex flex-col min-h-0">
          <ReadingPane
            selection={selection}
            account={folder.a}
            lang={i18n.language}
            identities={identities}
            onViewDoc={setPdfDocId}
            onOpenAccounting={() => navigate('/admin/accounting/inbox')}
            onCompose={(init, title) => setComposer({ init, title, accountKey: 'customers' })}
            t={t}
          />
        </section>
      </div>

      {pdfDocId != null && <PdfModal docId={pdfDocId} onClose={() => setPdfDocId(null)} t={t} />}
      {composer && (
        <MessageComposer
          init={composer.init}
          title={composer.title}
          accountKey={composer.accountKey}
          onClose={() => setComposer(null)}
          onSent={() => { queueQuery.refetch(); setActiveFolder('cust-sent'); }}
          t={t}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────── message list ──
const MessageList: React.FC<{
  folder: Folder;
  queue?: import('../../../services/email.service').EmailQueueItem[];
  received?: ReceivedEmail[];
  loading: boolean;
  selection: Selection;
  onSelect: (s: Selection) => void;
  t: (k: string, d?: string) => string;
}> = ({ folder, queue, received, loading, selection, onSelect, t }) => {
  if (folder.src === 'empty') {
    return (
      <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
        <Inbox className="w-8 h-8 mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
        {folder.note}
      </div>
    );
  }
  if (loading) return <div className="p-6"><Loading /></div>;

  const rows =
    folder.src === 'queue'
      ? (queue || []).map((m) => ({
          key: `q${m.id}`,
          onClick: () => onSelect({ kind: 'queue', id: m.id }),
          active: selection?.kind === 'queue' && selection.id === m.id,
          who: m.recipientEmail,
          subject: friendlyType(m.emailType),
          when: fmt(m.sentAt || m.createdAt),
          status: m.status,
          attach: 0,
        }))
      : (received || []).map((m) => ({
          key: `r${m.id}`,
          onClick: () => onSelect({ kind: 'received', item: m }),
          active: selection?.kind === 'received' && selection.item.id === m.id,
          who: m.from_address || '—',
          subject: m.subject || t('messages.noSubject', '(no subject)'),
          when: fmt(m.received_at),
          status: m.status,
          attach: m.attachment_count,
        }));

  if (rows.length === 0) {
    return <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">{t('messages.noMessages', 'No messages')}</div>;
  }

  return (
    <ul>
      {rows.map((r) => (
        <li key={r.key}>
          <button
            onClick={r.onClick}
            className={`w-full text-left px-4 py-3 border-b border-neutral-100 dark:border-neutral-800/70 border-l-[3px] transition-colors ${
              r.active
                ? 'border-l-accent-dark bg-accent-soft'
                : 'border-l-transparent hover:bg-neutral-50 dark:hover:bg-neutral-800/40'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[13.5px] text-neutral-800 dark:text-neutral-100 truncate">{r.who}</span>
              <span className="ml-auto text-[11px] text-neutral-400 tabular-nums whitespace-nowrap">{r.when}</span>
            </div>
            <div className="text-[13px] text-neutral-600 dark:text-neutral-300 truncate mt-0.5">{r.subject}</div>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full ${STATUS_STYLES[r.status] || 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'}`}>
                {r.status}
              </span>
              {r.attach > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] text-neutral-400">
                  <Paperclip className="w-3 h-3" />{r.attach}
                </span>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
};

// ─────────────────────────────────────────────────────────── reading pane ──
const ReadingPane: React.FC<{
  selection: Selection;
  account: Account;
  lang: string;
  identities?: MailIdentities | null;
  onViewDoc: (id: number) => void;
  onOpenAccounting: () => void;
  onCompose: (init: ComposerInit, title?: string) => void;
  t: (k: string, d?: string) => string;
}> = ({ selection, account, lang, identities, onViewDoc, onOpenAccounting, onCompose, t }) => {
  const detailQuery = useQuery({
    queryKey: ['messages', 'queue', selection?.kind === 'queue' ? selection.id : null],
    queryFn: () => emailService.getQueueItem((selection as { kind: 'queue'; id: number }).id),
    enabled: selection?.kind === 'queue',
  });

  if (!selection) {
    return (
      <div className="flex-1 grid place-items-center text-center text-neutral-400 dark:text-neutral-500 p-10">
        <div>
          <Mail className="w-9 h-9 mx-auto mb-3 text-neutral-300 dark:text-neutral-700" />
          <div className="text-sm">{t('messages.selectPrompt', 'Select a message to read')}</div>
        </div>
      </div>
    );
  }

  // Accounting toolbar only for the rechnungen@ stream; customer mail (inbound
  // or the automated/sent streams) gets the CRM action set.
  const isAcct = selection.kind === 'received'
    ? selection.item.account_key !== 'customers'
    : account.id === 'acct';

  const recipient = selection.kind === 'received'
    ? (selection.item.from_address || '')
    : (detailQuery.data?.recipientEmail || '');

  // Reply only makes sense for an inbound message with a sender.
  const onReply = selection.kind === 'received' && selection.item.from_address
    ? () => {
        const it = selection.item;
        const subj = /^re:/i.test(it.subject || '') ? (it.subject || '') : `Re: ${it.subject || ''}`;
        const quoted = `<p><br></p><p style="color:#888;font-size:12px">${t('messages.onWrote', 'On')} ${fmt(it.received_at)}, ${it.from_address}:</p>`;
        onCompose({ to: it.from_address || '', subject: subj, html: quoted, replyToReceivedId: it.id }, t('messages.reply', 'Reply'));
      }
    : undefined;

  // Create-from-template opens the composer with the rendered template loaded
  // (freely editable); empty key = blank compose (gallery has no send template).
  const onCreate = !isAcct
    ? async (key: string, label: string) => {
        if (!key) { onCompose({ to: recipient, subject: '', html: '' }, label); return; }
        try {
          const p = await emailService.previewTemplate(key, { customer_name: recipient.split('@')[0] || '' }, lang || 'en');
          onCompose({ to: recipient, subject: p.subject, html: p.body_html }, label);
        } catch {
          onCompose({ to: recipient, subject: label, html: '' }, label);
        }
      }
    : undefined;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <Toolbar isAcct={isAcct} onReply={onReply} onCreate={onCreate} t={t} />
      <div className="flex-1 overflow-y-auto p-6">
        {selection.kind === 'queue' ? (
          detailQuery.isLoading ? <Loading /> : detailQuery.data ? (
            <QueueDetail d={detailQuery.data} fromAddr={identities?.automated} t={t} />
          ) : (
            <div className="text-sm text-neutral-500">{t('messages.loadError', 'Could not load this message.')}</div>
          )
        ) : (
          <ReceivedDetail
            item={selection.item}
            mailboxAddr={selection.item.account_key === 'customers' ? identities?.customers : identities?.accounting}
            onViewDoc={onViewDoc}
            onOpenAccounting={onOpenAccounting}
            t={t}
          />
        )}
      </div>
    </div>
  );
};

const QueueDetail: React.FC<{ d: import('../../../services/email.service').EmailQueueDetail; fromAddr?: string | null; t: (k: string, d?: string) => string }> = ({ d, fromAddr, t }) => (
  <>
    <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100" style={{ textWrap: 'balance' } as React.CSSProperties}>
      {friendlyType(d.emailType)}
    </h2>
    <div className="mt-3 pb-4 border-b border-neutral-200 dark:border-neutral-800 text-sm">
      <div className="text-neutral-600 dark:text-neutral-300">
        {t('messages.from', 'from')} <span className="font-mono text-xs">{fromAddr || '—'}</span> · {t('messages.to', 'to')}{' '}
        <span className="font-semibold text-neutral-800 dark:text-neutral-100">{d.recipientEmail}</span>
      </div>
      {d.cc && <div className="text-neutral-500 dark:text-neutral-400 text-xs mt-0.5">cc {d.cc}</div>}
      <div className="text-neutral-400 dark:text-neutral-500 text-xs mt-0.5 tabular-nums">{fmt(d.sentAt || d.createdAt)}</div>
    </div>

    {d.renderedHtml ? (
      <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden bg-white" style={{ height: '52vh' }}>
        {/* rendered_html is our own template output — sandboxed, scripts blocked */}
        <iframe title="Email body" sandbox="allow-same-origin" srcDoc={d.renderedHtml} className="w-full h-full border-0" />
      </div>
    ) : (
      <div className="mt-4 text-sm text-neutral-500 dark:text-neutral-400 italic">
        {t('messages.noBody', 'This message was sent before body capture was added, so no preview is available.')}
      </div>
    )}

    {d.attachments.length > 0 && (
      <div className="mt-5">
        <div className="text-[11px] font-bold uppercase tracking-wide text-neutral-400 mb-2">
          {d.attachments.length} {t('messages.attachments', 'attachment(s)')}
        </div>
        <div className="flex flex-col gap-2 max-w-md">
          {d.attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/40">
              <FileText className="w-5 h-5 text-red-500 flex-none" />
              <span className="text-[13.5px] font-medium text-neutral-800 dark:text-neutral-100 truncate">{a.filename}</span>
              <span className="ml-auto text-[11px] text-neutral-400" title={t('messages.sentAttachHint', 'Sent attachments are not archived yet — Phase 2.')}>
                {t('messages.notArchived', 'not archived yet')}
              </span>
            </div>
          ))}
        </div>
      </div>
    )}
  </>
);

const ReceivedDetail: React.FC<{
  item: ReceivedEmail;
  mailboxAddr?: string | null;
  onViewDoc: (id: number) => void;
  onOpenAccounting: () => void;
  t: (k: string, d?: string) => string;
}> = ({ item, mailboxAddr, onViewDoc, onOpenAccounting, t }) => {
  const detail = useQuery({
    queryKey: ['messages', 'received', 'item', item.id],
    queryFn: () => emailService.getReceivedItem(item.id),
  });
  const toAddr = detail.data?.to_address || item.to_address || mailboxAddr || '—';
  return (
    <>
      <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100" style={{ textWrap: 'balance' } as React.CSSProperties}>
        {item.subject || t('messages.noSubject', '(no subject)')}
      </h2>
      <div className="mt-3 pb-4 border-b border-neutral-200 dark:border-neutral-800 text-sm">
        <div className="text-neutral-600 dark:text-neutral-300">
          {t('messages.from', 'from')} <span className="font-semibold text-neutral-800 dark:text-neutral-100">{item.from_address || '—'}</span>
          {' · '}{t('messages.to', 'to')} <span className="font-mono text-xs">{toAddr}</span>
        </div>
        <div className="text-neutral-400 dark:text-neutral-500 text-xs mt-0.5 tabular-nums">{fmt(item.received_at)}</div>
      </div>

      {detail.isLoading ? (
        <div className="mt-4"><Loading /></div>
      ) : detail.data?.body_html ? (
        <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden bg-white" style={{ height: '48vh' }}>
          {/* Sanitized server-side; rendered with a strict (script-less, no
              same-origin) sandbox as a second layer against untrusted mail. */}
          <iframe title="Email body" sandbox="" srcDoc={detail.data.body_html} className="w-full h-full border-0" />
        </div>
      ) : detail.data?.body_text ? (
        <pre className="mt-4 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300 font-sans">{detail.data.body_text}</pre>
      ) : (
        <div className="mt-4 text-sm text-neutral-500 dark:text-neutral-400 italic">
          {t('messages.noInboundBody', 'No message body was captured for this email.')}
        </div>
      )}

      {item.inbound_document_id != null && (
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={() => onViewDoc(item.inbound_document_id as number)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent-dark hover:opacity-90 text-white text-sm font-medium"
          >
            <FileText className="w-4 h-4" />{t('messages.viewDocument', 'View document')}
          </button>
          <button
            onClick={onOpenAccounting}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            <Link2 className="w-4 h-4" />{t('messages.openInAccounting', 'Open in Accounting inbox')}
          </button>
        </div>
      )}
      {item.error && (
        <div className="mt-4 text-sm text-red-600 dark:text-red-400">{item.error}</div>
      )}
    </>
  );
};

// ─────────────────────────────────────────────────────────────── toolbar ──
const Toolbar: React.FC<{
  isAcct: boolean;
  onReply?: () => void;
  onCreate?: (key: string, label: string) => void;
  t: (k: string, d?: string) => string;
}> = ({ isAcct, onReply, onCreate, t }) => {
  const Tb: React.FC<{ icon: LucideIcon; label: string; accent?: boolean; onClick?: () => void }> = ({ icon: Icon, label, accent, onClick }) => {
    const enabled = !!onClick;
    return (
      <button
        onClick={onClick}
        disabled={!enabled}
        title={enabled ? undefined : t('messages.soon', 'Available in a later phase')}
        className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[13px] font-medium ${
          enabled ? 'hover:bg-neutral-100 dark:hover:bg-neutral-800 ' : 'cursor-not-allowed opacity-50 '
        }${accent ? 'text-accent-dark font-semibold' : 'text-neutral-600 dark:text-neutral-300'}`}
      >
        <Icon className="w-[15px] h-[15px]" />{label}
      </button>
    );
  };
  const create = (key: string, labelKey: string, fallback: string) =>
    onCreate ? () => onCreate(key, t(labelKey, fallback)) : undefined;
  return (
    <div className="flex items-center gap-1 flex-wrap px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 flex-none">
      <Tb icon={Reply} label={t('messages.reply', 'Reply')} onClick={onReply} />
      <Tb icon={ReplyAll} label={t('messages.replyAll', 'Reply all')} />
      <Tb icon={Forward} label={t('messages.forward', 'Forward')} />
      <span className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-1" />
      {isAcct ? (
        <>
          <Tb icon={ReceiptText} label={t('messages.bookExpense', 'Book as expense')} accent />
          <Tb icon={Forward} label={t('messages.rebill', 'Re-bill to client')} accent />
        </>
      ) : (
        <>
          <Tb icon={Quote} label={t('messages.createQuote', 'Quote')} accent onClick={create('quote_sent', 'messages.createQuote', 'Quote')} />
          <Tb icon={FileSignature} label={t('messages.createContract', 'Contract')} accent onClick={create('contract_sent', 'messages.createContract', 'Contract')} />
          <Tb icon={ImageIcon} label={t('messages.createGallery', 'Gallery')} accent onClick={create('', 'messages.createGallery', 'Gallery')} />
          <Tb icon={FileText} label={t('messages.createInvoice', 'Invoice')} accent onClick={create('invoice_sent', 'messages.createInvoice', 'Invoice')} />
        </>
      )}
      <span className="flex-1" />
      <Tb icon={Archive} label={t('messages.archive', 'Archive')} />
      <Tb icon={Trash2} label={t('messages.delete', 'Delete')} />
    </div>
  );
};

// ─────────────────────────────────────────────────────────────── pdf modal ──
const PdfModal: React.FC<{ docId: number; onClose: () => void; t: (k: string, d?: string) => string }> = ({ docId, onClose, t }) => {
  const [page, setPage] = useState(1);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setErr(false);
    setUrl(null);
    accountingService.getInboundPageBlob(docId, page)
      .then((blob) => {
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        revoked = u;
        setUrl(u);
      })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; if (revoked) URL.revokeObjectURL(revoked); };
  }, [docId, page]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6" onClick={onClose}>
      <div className="bg-white dark:bg-neutral-900 rounded-xl w-[min(620px,94vw)] max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <FileText className="w-4 h-4 text-red-500" />
          <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{t('messages.document', 'Document')}</span>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              className="w-8 h-8 grid place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs tabular-nums text-neutral-500 w-6 text-center">{page}</span>
            <button onClick={() => setPage((p) => p + 1)}
              className="w-8 h-8 grid place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
              <ChevronRight className="w-4 h-4" />
            </button>
            <button onClick={onClose} aria-label={t('messages.close', 'Close')}
              className="w-8 h-8 grid place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 ml-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="overflow-auto p-5 bg-neutral-100 dark:bg-neutral-800 grid place-items-center min-h-[240px]">
          {err ? (
            <div className="text-sm text-neutral-500 dark:text-neutral-400">{t('messages.previewUnavailable', 'Preview unavailable')}</div>
          ) : url ? (
            <img src={url} alt="" className="max-w-full shadow-lg rounded" />
          ) : (
            <Loading />
          )}
        </div>
        <div className="text-center text-[11px] text-neutral-400 py-2 border-t border-neutral-200 dark:border-neutral-800">
          {t('messages.rasterNote', 'Server-rendered preview — the raw file never reaches the browser.')}
        </div>
      </div>
    </div>
  );
};

export default MessagesPage;

/**
 * Everything the project holds, grouped by the stage it belongs to: quotes,
 * contracts, galleries, invoices. Each row opens its document; an empty
 * group says so. The gallery group keeps the "attach a gallery" search the
 * page always had.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { FileText, Image as ImageIcon, Plus, Receipt, ScrollText, Search } from 'lucide-react';
import { Badge, Card, Input, type BadgeTone } from '../../../components/common';
import { eventsService } from '../../../services/events.service';
import { projectsService, type ProjectOverview } from '../../../services/projects.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { formatMoneyMinor } from '../../../utils/money';

const QUOTE_TONE: Record<string, BadgeTone> = {
  draft: 'neutral', sent: 'info', expired: 'warning', accepted: 'success', declined: 'danger', converted: 'success',
};
const CONTRACT_TONE: Record<string, BadgeTone> = {
  draft: 'neutral', sent: 'info', awaiting_data: 'info', signed_by_customer: 'info', signed_by_admin: 'info',
  fully_signed: 'success', cancelled: 'danger', declined: 'danger', expired: 'warning',
};
const INVOICE_TONE: Record<string, BadgeTone> = {
  scheduled: 'neutral', draft: 'neutral', pending_delivery: 'warning', sent: 'info', paid: 'success',
  overdue: 'danger', cancelled: 'storno', skipped: 'neutral',
};
const truthy = (v: unknown) => v === true || v === 1 || v === '1';

interface Props {
  data: ProjectOverview;
  flags: Record<string, boolean>;
  can: (perm: string) => boolean;
  canAttachGallery: boolean;
}

const Row: React.FC<{
  icon: React.ReactNode; title: string; subtitle?: string; badge?: React.ReactNode; amount?: string; href?: string | null;
}> = ({ icon, title, subtitle, badge, amount, href }) => {
  const navigate = useNavigate();
  const body = (
    <>
      <span className="w-8 h-8 rounded-lg grid place-items-center bg-inset text-soft shrink-0">{icon}</span>
      <span className="flex-1 min-w-[10rem]">
        <span className="block text-sm font-semibold text-heading truncate">{title}</span>
        {subtitle && <span className="block text-xs text-muted truncate">{subtitle}</span>}
      </span>
      {badge}
      {amount && <span className="text-sm font-semibold text-heading tabular-nums">{amount}</span>}
    </>
  );
  const cls = 'w-full flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line px-3 py-2.5 text-left';
  return href ? (
    <button type="button" onClick={() => navigate(href)} className={`${cls} hover:bg-hover-soft`}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
};

const Group: React.FC<{ title: string; empty: string; children?: React.ReactNode; footer?: React.ReactNode }> = ({ title, empty, children, footer }) => {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">{title}</h3>
      <div className="space-y-1.5">
        {rows.length ? rows : (
          <p className="rounded-xl border border-dashed border-line-strong px-3 py-2.5 text-sm text-muted">{empty}</p>
        )}
        {footer}
      </div>
    </section>
  );
};

export const ProjectDocumentsCard: React.FC<Props> = ({ data, flags, can, canAttachGallery }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const qc = useQueryClient();
  const projectId = data.project.id;
  const [eventSearch, setEventSearch] = useState('');

  const { data: eventResults } = useQuery({
    queryKey: ['project-event-search', eventSearch],
    queryFn: () => eventsService.getEvents({ limit: 10, search: eventSearch }),
    enabled: canAttachGallery && eventSearch.trim().length >= 2,
  });
  const attach = useMutation({
    mutationFn: (eventId: number) => projectsService.assignEvent(projectId, eventId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-overview', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      setEventSearch('');
      toast.success(t('projects.events.attached', 'Gallery attached') as string);
    },
    onError: (err: unknown) => {
      const res = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      if (res?.code === 'PROJECT_CUSTOMER_MISMATCH') {
        toast.error(t('projects.error.customerMismatch', 'That belongs to a different customer than this project.') as string);
        return;
      }
      toast.error(res?.error || (t('projects.events.attachFailed', 'Could not attach gallery') as string));
    },
  });

  const link = (flag: string, href: string) => (flags[flag] ? href : null);
  // A group the admin cannot have (feature off, or no view permission: the
  // overview leaves those documents out) is not shown as "none yet".
  const shows = (flag: string, perm: string) => !!flags[flag] && can(perm);
  // Nor is a group whose stage this project skips, while it holds nothing:
  // the stage strip already says "skipped". The gallery group stays for its
  // attach search.
  const skipped = (key: string, count: number) => count === 0
    && data.stage?.stages.some((s) => s.key === key && s.state === 'skipped');
  const date = (d: string | null | undefined) => (d ? format(d) : '');

  return (
    <Card>
      <h2 className="text-base font-semibold text-heading mb-4">{t('projects.documents.title', 'Documents & galleries')}</h2>
      <div className="space-y-5">
        {shows('quotes', 'quotes.view') && !skipped('quote', data.quotes.length) && (
        <Group title={t('projects.stage.quote', 'Quote')} empty={t('projects.documents.noQuote', 'No quote yet.')}>
          {data.quotes.map((q) => (
            <Row
              key={q.id}
              icon={<FileText className="w-4 h-4" />}
              title={q.quote_number}
              subtitle={date(q.issue_date)}
              badge={<Badge tone={QUOTE_TONE[q.status] ?? 'neutral'}>{t(`quotes.status.${q.status}`, q.status)}</Badge>}
              amount={formatMoneyMinor(Number(q.total_amount_minor), q.currency)}
              href={link('quotes', `/admin/clients/quotes/${q.id}`)}
            />
          ))}
        </Group>
        )}

        {shows('contracts', 'contracts.view') && !skipped('contract', data.contracts.length) && (
        <Group title={t('projects.stage.contract', 'Contract')} empty={t('projects.documents.noContract', 'No contract yet.')}>
          {data.contracts.map((c) => (
            <Row
              key={c.id}
              icon={<ScrollText className="w-4 h-4" />}
              title={c.contract_number}
              subtitle={c.signed_by_customer_at
                ? t('projects.documents.signedOn', 'signed on {{date}}', { date: date(c.signed_by_customer_at) })
                : date(c.issue_date)}
              badge={<Badge tone={CONTRACT_TONE[c.status] ?? 'neutral'}>{t(`contracts.status.${c.status}`, c.status)}</Badge>}
              href={link('contracts', `/admin/clients/contracts/${c.id}`)}
            />
          ))}
        </Group>
        )}

        <Group
          title={t('projects.stage.gallery', 'Gallery')}
          empty={t('projects.documents.noGallery', 'No gallery yet.')}
          footer={canAttachGallery ? (
            <div className="relative max-w-sm pt-1">
              <Input
                id="project-attach-gallery"
                value={eventSearch}
                onChange={(e) => setEventSearch(e.target.value)}
                leftIcon={<Search className="w-4 h-4" />}
                placeholder={t('projects.events.searchPlaceholder', 'Attach a gallery — search by name…') as string}
                aria-label={t('projects.events.searchPlaceholder', 'Attach a gallery — search by name…') as string}
              />
              {eventSearch.trim().length >= 2 && eventResults?.events && eventResults.events.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-lg border border-line bg-panel shadow-lg max-h-56 overflow-auto">
                  {eventResults.events
                    .filter((ev) => !data.events.some((existing) => existing.id === ev.id))
                    .map((ev) => (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => attach.mutate(ev.id)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover"
                      >
                        <Plus className="w-3 h-3 text-faint" />
                        <span className="flex-1 truncate text-heading">{ev.event_name}</span>
                        <span className="text-xs text-muted">{date(ev.event_date)}</span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          ) : undefined}
        >
          {data.events.map((ev) => (
            <Row
              key={ev.id}
              icon={<ImageIcon className="w-4 h-4" />}
              title={ev.event_name}
              subtitle={date(ev.event_date)}
              badge={truthy(ev.is_archived)
                ? <Badge tone="neutral">{t('events.archived', 'Archived')}</Badge>
                : truthy(ev.is_draft)
                  ? <Badge tone="warning">{t('projects.documents.draft', 'Draft')}</Badge>
                  : <Badge tone="success">{t('projects.documents.published', 'Published')}</Badge>}
              href={`/admin/events/${ev.id}`}
            />
          ))}
        </Group>

        {shows('bills', 'bills.view') && !skipped('invoice', data.invoices.length) && (
        <Group title={t('projects.documents.invoices', 'Invoices')} empty={t('projects.documents.noInvoice', 'No invoice yet.')}>
          {data.invoices.map((inv) => (
            <Row
              key={inv.id}
              icon={<Receipt className="w-4 h-4" />}
              title={inv.invoice_number}
              subtitle={inv.paid_at
                ? t('projects.documents.paidOn', 'paid on {{date}}', { date: date(inv.paid_at) })
                : date(inv.issue_date)}
              badge={<Badge tone={INVOICE_TONE[inv.status] ?? 'neutral'}>{t(`bills.status.${inv.status}`, inv.status)}</Badge>}
              amount={formatMoneyMinor(Number(inv.total_amount_minor), inv.currency)}
              href={link('bills', `/admin/clients/bills/${inv.id}`)}
            />
          ))}
        </Group>
        )}
      </div>
    </Card>
  );
};

/**
 * What the project page offers as the next step, from the stage the server
 * derived (projectService.deriveStages) and the documents the project holds.
 *
 * Each step either opens a page (an editor prefilled from the project, or the
 * document that needs finishing) or runs an existing conversion, so a quote
 * becomes a contract and a contract a gallery the way they do on their own
 * pages. Every step is gated on the same feature flag and permissions as the
 * route it reaches; a step the admin cannot take is left out, not disabled.
 */
import type { ProjectOverview, ProjectStageKey } from '../../../services/projects.service';

export type StepKind =
  | 'createQuote' | 'openQuote'
  | 'createContract' | 'openContract'
  | 'createGallery' | 'convertContractToGallery' | 'convertQuoteToGallery' | 'openGallery'
  | 'createInvoice' | 'openInvoice'
  | 'complete';

export interface ProjectStep {
  kind: StepKind;
  stage: ProjectStageKey;
  /** Where it goes; absent for a step that runs an action. */
  href?: string;
  /** The document a conversion starts from. */
  sourceId?: number;
}

interface Ctx {
  flags: Record<string, boolean>;
  can: (perm: string) => boolean;
}

const QUOTE_ACCEPTED = new Set(['accepted']);
const QUOTE_OPEN = new Set(['draft', 'sent']);
const truthy = (v: unknown) => v === true || v === 1 || v === '1';

/** Query string for an editor prefilled from the project. */
function prefill(data: ProjectOverview, extra: Record<string, string | number | null | undefined> = {}): string {
  const p = new URLSearchParams({ projectId: String(data.project.id) });
  if (data.project.customerAccountId) p.set('customerAccountId', String(data.project.customerAccountId));
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, String(v));
  return p.toString();
}

/** The step for `stage`, or null when there is none the admin may take. */
export function stepFor(stage: ProjectStageKey, data: ProjectOverview, { flags, can }: Ctx): ProjectStep | null {
  const { quotes, contracts, events, invoices } = data;
  // New quotes, contracts and invoices can only join a project the admin
  // created (the CRM write rule); opening existing ones is still offered.
  const linkable = data.project.documentsLinkable !== false;
  switch (stage) {
    case 'quote': {
      if (!flags.quotes) return null;
      const open = quotes.find((q) => QUOTE_OPEN.has(q.status));
      if (open && can('quotes.view')) return { kind: 'openQuote', stage, href: `/admin/clients/quotes/${open.id}` };
      if (linkable && can('quotes.manage')) return { kind: 'createQuote', stage, href: `/admin/clients/quotes/new?${prefill(data)}` };
      return null;
    }
    case 'contract': {
      if (!flags.contracts) return null;
      const open = contracts.find((c) => c.status !== 'fully_signed' && !['cancelled', 'declined', 'expired', 'superseded'].includes(c.status));
      if (open && can('contracts.view')) return { kind: 'openContract', stage, href: `/admin/clients/contracts/${open.id}` };
      const accepted = quotes.find((q) => QUOTE_ACCEPTED.has(q.status));
      // POST /quotes/:id/convert-to-contract: quotes.manage + contracts.manage.
      if (linkable && accepted && can('quotes.manage') && can('contracts.manage')) {
        return { kind: 'createContract', stage, sourceId: accepted.id };
      }
      return null;
    }
    case 'gallery': {
      const draft = events.find((e) => truthy(e.is_draft));
      if (draft) return { kind: 'openGallery', stage, href: `/admin/events/${draft.id}` };
      // The conversions need events.create + bills.manage + the document's
      // manage permission (adminQuotes / adminContracts convert routes).
      const canConvert = can('events.create') && can('bills.manage');
      const signed = contracts.find((c) => c.status === 'fully_signed');
      if (signed && flags.contracts && canConvert && can('contracts.manage')) {
        return { kind: 'convertContractToGallery', stage, sourceId: signed.id };
      }
      const accepted = quotes.find((q) => QUOTE_ACCEPTED.has(q.status));
      if (accepted && flags.quotes && canConvert && can('quotes.manage')) {
        return { kind: 'convertQuoteToGallery', stage, sourceId: accepted.id };
      }
      // The new gallery joins the project through POST /projects/:id/events (events.edit).
      if (can('events.create') && can('events.edit')) return { kind: 'createGallery', stage, href: `/admin/events/new?${prefill(data)}` };
      return null;
    }
    case 'invoice': {
      if (!flags.bills) return null;
      const unpaid = invoices.find((i) => i.kind !== 'storno' && !['paid', 'cancelled', 'skipped'].includes(i.status));
      if (unpaid && can('bills.view')) return { kind: 'openInvoice', stage, href: `/admin/clients/bills/${unpaid.id}` };
      if (!linkable || !can('bills.manage') || !data.project.customerAccountId) return null;
      // A monthly or manual customer's invoices go into one collected draft,
      // which POST /invoices refuses to tie to a project (422).
      if (['monthly', 'manual'].includes(data.project.customerBillingCadence || '')) return null;
      const gallery = events[0];
      return {
        kind: 'createInvoice',
        stage,
        href: `/admin/clients/bills/new?${prefill(data, gallery ? { eventId: gallery.id, eventName: gallery.event_name, eventDate: gallery.event_date } : {})}`,
      };
    }
    case 'done':
      return can('events.edit') ? { kind: 'complete', stage } : null;
    default:
      return null;
  }
}

/** The main step (the current stage's) and the later stages one can jump to. */
export function projectSteps(data: ProjectOverview, ctx: Ctx): { main: ProjectStep | null; later: ProjectStep[] } {
  const current = data.stage?.current ?? null;
  if (!current) return { main: null, later: [] };
  const order = data.stage.stages.map((s) => s.key);
  const main = stepFor(current, data, ctx);
  const stateOf = new Map(data.stage.stages.map((s) => [s.key, s.state]));
  const later = order
    .slice(order.indexOf(current) + 1)
    .filter((key) => key !== 'done' && stateOf.get(key) !== 'skipped')
    .map((key) => stepFor(key, data, ctx))
    .filter((s): s is ProjectStep => !!s && s.kind.startsWith('create'));
  return { main, later };
}

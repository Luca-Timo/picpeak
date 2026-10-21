/**
 * Labels, icons and the runner for the project page's steps (projectSteps.ts).
 * Opening a page navigates; a conversion runs the same endpoint the
 * document's own page uses, then opens what it made; "Complete" sets the
 * project's status. Each is an action, outside the save bar (UX.md › Saving).
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { CheckCircle2, FileText, Image as ImageIcon, Receipt, ScrollText } from 'lucide-react';
import { quotesService } from '../../../services/quotes.service';
import { contractsService } from '../../../services/contracts.service';
import { projectsService } from '../../../services/projects.service';
import type { ProjectStep, StepKind } from './projectSteps';

const ICON: Record<StepKind, React.ComponentType<{ className?: string }>> = {
  createQuote: FileText, openQuote: FileText,
  createContract: ScrollText, openContract: ScrollText,
  createGallery: ImageIcon, convertContractToGallery: ImageIcon, convertQuoteToGallery: ImageIcon, openGallery: ImageIcon,
  createInvoice: Receipt, openInvoice: Receipt,
  complete: CheckCircle2,
};

export function useStepLabel() {
  const { t } = useTranslation();
  return (kind: StepKind): string => {
    switch (kind) {
      case 'createQuote': return t('projects.step.createQuote', 'Create quote');
      case 'openQuote': return t('projects.step.openQuote', 'Open quote');
      case 'createContract': return t('projects.step.createContract', 'Create contract');
      case 'openContract': return t('projects.step.openContract', 'Open contract');
      case 'createGallery':
      case 'convertContractToGallery':
      case 'convertQuoteToGallery': return t('projects.step.createGallery', 'Create gallery');
      case 'openGallery': return t('projects.step.openGallery', 'Open gallery');
      case 'createInvoice': return t('projects.step.createInvoice', 'Create invoice');
      case 'openInvoice': return t('projects.step.openInvoice', 'Open invoice');
      case 'complete': return t('projects.step.complete', 'Complete project');
      default: return '';
    }
  };
}

/** What the step does with the project's data, for the "next step" box. */
export function useStepHint() {
  const { t } = useTranslation();
  return (kind: StepKind): string => {
    switch (kind) {
      case 'createQuote': return t('projects.stepHint.createQuote', 'Customer, occasion, date and the project link are taken into the quote.');
      case 'openQuote': return t('projects.stepHint.openQuote', 'The quote is waiting to be sent or accepted.');
      case 'createContract': return t('projects.stepHint.createContract', 'The contract is made from the accepted quote and stays in this project.');
      case 'openContract': return t('projects.stepHint.openContract', 'The contract is waiting for its signatures.');
      case 'convertContractToGallery': return t('projects.stepHint.convertContract', 'The gallery is made from the signed contract, with its payment plan.');
      case 'convertQuoteToGallery': return t('projects.stepHint.convertQuote', 'The gallery is made from the accepted quote, with its payment plan.');
      case 'createGallery': return t('projects.stepHint.createGallery', 'Name, occasion, date and customer are taken into the new gallery.');
      case 'openGallery': return t('projects.stepHint.openGallery', 'Upload the photos and publish the gallery.');
      case 'createInvoice': return t('projects.stepHint.createInvoice', 'The invoice is made for this project\'s customer and stays in this project.');
      case 'openInvoice': return t('projects.stepHint.openInvoice', 'An invoice is still open.');
      case 'complete': return t('projects.stepHint.complete', 'Every step is done or skipped. Complete the project to take it off the dashboard.');
      default: return '';
    }
  };
}

export function StepIcon({ kind, className = 'w-4 h-4' }: { kind: StepKind; className?: string }) {
  const Icon = ICON[kind];
  return <Icon className={className} />;
}

export function useRunStep(projectId: number) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async ({ step, contractTemplateId = null }: { step: ProjectStep; contractTemplateId?: number | null }): Promise<string | null> => {
      switch (step.kind) {
        case 'createContract': {
          const r = await quotesService.convertToContract(step.sourceId as number, contractTemplateId);
          return `/admin/clients/contracts/${r.contractId}`;
        }
        case 'convertContractToGallery': {
          const r = await contractsService.convertToEvent(step.sourceId as number);
          return `/admin/events/${r.eventId}`;
        }
        case 'convertQuoteToGallery': {
          const r = await quotesService.convert(step.sourceId as number);
          return `/admin/events/${r.eventId}`;
        }
        case 'complete':
          await projectsService.update(projectId, { status: 'completed' });
          return null;
        default:
          return step.href ?? null;
      }
    },
    onSuccess: (href, { step }) => {
      qc.invalidateQueries({ queryKey: ['project-overview', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      if (step.kind === 'createContract') toast.success(t('projects.toast.contractCreated', 'Contract created from the quote.') as string);
      if (step.kind === 'convertContractToGallery' || step.kind === 'convertQuoteToGallery') {
        toast.success(t('projects.toast.galleryCreated', 'Gallery created as a draft.') as string);
      }
      if (step.kind === 'complete') toast.success(t('projects.toast.completed', 'Project completed.') as string);
      if (href) navigate(href);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || (t('projects.toast.stepFailed', 'That did not work. Try again.') as string));
    },
  });

  /** Opens the step's page, or runs it. `createContract` takes the contract
   *  template the admin picked in ConvertToContractDialog. */
  const run = (step: ProjectStep, contractTemplateId: number | null = null) => {
    if (step.href && !step.kind.startsWith('convert') && step.kind !== 'createContract' && step.kind !== 'complete') {
      navigate(step.href);
      return;
    }
    mutation.mutate({ step, contractTemplateId });
  };

  return { run, isRunning: mutation.isPending };
}

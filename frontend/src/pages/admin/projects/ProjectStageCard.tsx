/**
 * Where the project stands: the six stages as a tracker (a vertical list on a
 * phone), then the next step in words. The next step's button is the page's
 * primary action in the header (UX.md › Page anatomy), so this card names it
 * and offers only the later stages one can jump to, as quiet buttons.
 *
 * Every state carries a word next to its colour (STYLING.md › Status).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, EyeOff, X } from 'lucide-react';
import { Button, Card } from '../../../components/common';
import type { ProjectOverview, ProjectStageKey, ProjectStageState } from '../../../services/projects.service';
import type { ProjectStep } from './projectSteps';
import { StepIcon, useStepHint, useStepLabel } from './useProjectSteps';

interface Props {
  data: ProjectOverview;
  main: ProjectStep | null;
  later: ProjectStep[];
  onRun: (step: ProjectStep) => void;
  busy: boolean;
}

export const ProjectStageCard: React.FC<Props> = ({ data, main, later, onRun, busy }) => {
  const { t } = useTranslation();
  const label = useStepLabel();
  const hint = useStepHint();
  const stages = data.stage?.stages || [];
  const position = stages.findIndex((s) => s.state === 'current');
  const status = data.project.status;

  const stageName = (key: ProjectStageKey) => t(`projects.stage.${key}`);
  const stateWord = (state: ProjectStageState) => t(`projects.stageState.${state}`);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-base font-semibold text-heading">{t('projects.stage.title', 'Progress')}</h2>
        {position >= 0 && (
          <span className="text-xs text-muted">
            {t('projects.stage.position', 'Stage {{n}} of {{total}}', { n: position + 1, total: stages.length })}
          </span>
        )}
      </div>

      <ol className="grid grid-cols-1 sm:grid-cols-6 gap-3 sm:gap-0 mb-4" aria-label={t('projects.stage.title', 'Progress') as string}>
        {stages.map((s, i) => {
          const done = s.state === 'done';
          const current = s.state === 'current';
          const stopped = s.state === 'cancelled';
          const circle = done
            ? 'bg-success border-success text-white'
            : stopped
              ? 'bg-danger border-danger text-white'
              : current
              ? 'bg-accent-strong border-accent-strong text-accent-fg'
              : `bg-panel border-fill-strong text-faint ${s.state === 'skipped' ? 'border-dashed' : ''}`;
          const word = done ? 'text-success-text' : stopped ? 'text-danger-text font-medium' : current ? 'text-accent font-medium' : 'text-muted';
          return (
            <li
              key={s.key}
              aria-current={current ? 'step' : undefined}
              className="relative flex sm:flex-col items-center gap-3 sm:gap-2 sm:text-center"
            >
              {i > 0 && (
                <span
                  aria-hidden
                  className={`hidden sm:block absolute top-4 right-1/2 w-full h-0.5 ${stopped ? 'bg-danger' : done || current ? 'bg-success' : 'bg-fill'}`}
                />
              )}
              <span className={`relative z-10 w-8 h-8 shrink-0 rounded-full border-2 grid place-items-center text-sm font-semibold ${circle}`}>
                {done ? <Check className="w-4 h-4" /> : stopped ? <X className="w-4 h-4" /> : s.state === 'hidden' ? <EyeOff className="w-4 h-4" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-sm font-semibold ${current || done || stopped ? 'text-heading' : 'text-soft'}`}>{stageName(s.key)}</span>
                <span className={`block text-xs ${word}`}>{stateWord(s.state)}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {status === 'cancelled' || status === 'completed' ? (
        <p className="text-sm text-muted">
          {status === 'cancelled'
            ? t('projects.stage.cancelledNote', 'This project is cancelled. Reopen it in Settings to continue.')
            : t('projects.stage.completedNote', 'This project is completed.')}
        </p>
      ) : main ? (
        <div className="rounded-xl border border-line bg-subtle px-4 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="text-xs text-muted">{t('projects.stage.next', 'Next step')}</div>
            <div className="text-sm font-semibold text-heading">{label(main.kind)}</div>
            <div className="text-sm text-muted">{hint(main.kind)}</div>
          </div>
          {later.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">{t('projects.stage.orJump', 'Or skip ahead:')}</span>
              {later.map((step) => (
                <Button
                  key={step.kind}
                  variant="ghost"
                  size="sm"
                  leftIcon={<StepIcon kind={step.kind} />}
                  disabled={busy}
                  onClick={() => onRun(step)}
                >
                  {label(step.kind)}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">{t('projects.stage.noStep', 'Nothing for you to do here right now.')}</p>
      )}
    </Card>
  );
};

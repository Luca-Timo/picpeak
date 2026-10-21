/**
 * `?projectId=` on a "new document" editor: the project page's next step
 * opens the quote, contract, invoice or gallery editor with it, and the
 * editor takes the project's data as its starting values. Runs once, only
 * when creating. A failed load (the `projects` feature off answers 403, a
 * foreign project 404) leaves the editor as it would be without the link.
 *
 * Returns the requested project id (null without one). A caller that links
 * the new document itself (the gallery page) goes through a route that vets
 * the project, so a submit made before the load finished still lands in it.
 */
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { projectsService, type ProjectSummary } from '../../../services/projects.service';

export function useProjectPrefill(onLoad: (project: ProjectSummary) => void, { enabled = true }: { enabled?: boolean } = {}): number | null {
  const [searchParams] = useSearchParams();
  const raw = searchParams.get('projectId');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const done = useRef(false);
  const callback = useRef(onLoad);
  callback.current = onLoad;

  useEffect(() => {
    if (!enabled || !requested || done.current) return;
    done.current = true;
    projectsService.get(requested)
      .then((project) => callback.current(project))
      .catch(() => { /* the editor still works without the project's data */ });
  }, [enabled, requested]);

  return requested;
}

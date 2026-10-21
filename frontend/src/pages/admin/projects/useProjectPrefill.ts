/**
 * `?projectId=` on a "new document" editor: the project page's next step
 * opens the quote, contract, invoice or gallery editor with it, and the
 * editor takes the project's data as its starting values. Runs once, only
 * when creating. A failed load (the `projects` feature off answers 403, a
 * foreign project 404) leaves the editor as it would be without the link.
 *
 * Returns the project's id once it has loaded, else null, so a caller never
 * links a document to a project it could not read.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { projectsService, type ProjectSummary } from '../../../services/projects.service';

export function useProjectPrefill(onLoad: (project: ProjectSummary) => void, { enabled = true }: { enabled?: boolean } = {}): number | null {
  const [searchParams] = useSearchParams();
  const raw = searchParams.get('projectId');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const done = useRef(false);
  const callback = useRef(onLoad);
  callback.current = onLoad;

  useEffect(() => {
    if (!enabled || !requested || done.current) return;
    done.current = true;
    projectsService.get(requested)
      .then((project) => {
        callback.current(project);
        setLoadedId(project.id);
      })
      .catch(() => { /* the editor still works without the project's data */ });
  }, [enabled, requested]);

  return loadedId;
}

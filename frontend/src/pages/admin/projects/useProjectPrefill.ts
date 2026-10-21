/**
 * `?projectId=` on a "new document" editor: the project page's next step
 * opens the quote, contract, invoice or gallery editor with it, and the
 * editor takes the project's data as its starting values. Runs once, only
 * when creating.
 *
 * Returns the project id from the URL straight away, so a document saved
 * before the load finished still joins the project, and null once the load
 * has failed (the `projects` feature off answers 403, a foreign project 404):
 * then the editor works as it would without the link, and `onError` lets it
 * clear an id it already took over.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { projectsService, type ProjectSummary } from '../../../services/projects.service';

export function useProjectPrefill(
  onLoad: (project: ProjectSummary) => void,
  { enabled = true, onError }: { enabled?: boolean; onError?: (projectId: number) => void } = {},
): number | null {
  const [searchParams] = useSearchParams();
  const raw = searchParams.get('projectId');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const requested = enabled && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const [failed, setFailed] = useState(false);
  const done = useRef(false);
  const callbacks = useRef({ onLoad, onError });
  callbacks.current = { onLoad, onError };

  useEffect(() => {
    if (!requested || done.current) return;
    done.current = true;
    projectsService.get(requested)
      .then((project) => callbacks.current.onLoad(project))
      .catch(() => {
        setFailed(true);
        callbacks.current.onError?.(requested);
      });
  }, [requested]);

  return failed ? null : requested;
}

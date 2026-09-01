import { useEffect, useState } from 'react';

/**
 * Navigation without a router library, for the reason `App` gates on a session
 * without one: the console is a fleet list and an agent detail, and a full
 * router is three files to choose between two shapes the URL already encodes.
 *
 * The panel serves `index.html` for any non-API path (the SPA fallback), so a
 * deep link or a reload on `/agents/:id` lands here and resolves once the path is
 * read. `navigate` pushes the URL and fires `popstate` so the same listener that
 * handles back/forward also handles an in-app move - one code path, not two.
 */

export const fleetPath = '/';

export const agentPath = (id: string): string =>
  `/agents/${encodeURIComponent(id)}`;

export const navigate = (path: string): void => {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

/** The current pathname, re-read on back/forward and on any `navigate`. */
export const usePath = (): string => {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
};

/** The agent id when the path is an agent-detail route, else null. */
export const agentIdFromPath = (path: string): string | null => {
  const match = /^\/agents\/([^/]+)\/?$/.exec(path);
  return match === null ? null : decodeURIComponent(match[1]);
};

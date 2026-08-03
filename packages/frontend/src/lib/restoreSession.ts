/**
 * Ask the server to rebuild the desktop from a past transcript.
 *
 * Two id namespaces meet in this one call, and conflating them is what makes restored
 * apps break:
 *
 * - `logSessionId` (the path) names a **transcript on disk** — a `session_logs/` directory
 *   like `2026-08-03_12-37-06`, which is what `/api/sessions` is keyed by.
 * - `sessionId` (the body) names the **live session** we are restoring into — the hub id
 *   (`ses-…`) this socket is attached to.
 *
 * The server mints an iframe token for every window it brings back, and those tokens must
 * name the live session. Restoring without saying which one made the server fall back to
 * the path id, so every restored app held a token for a session the hub never held: each
 * session-scoped verb it made (`yaar://session/agents`, `yaar://windows`, …) parked for
 * the full server-side wait and then answered 503, for the life of the window.
 */
import { useDesktopStore } from '@/store';
import { apiFetch } from '@/lib/api';

export function restoreSession(logSessionId: string): Promise<Response> {
  return apiFetch(`/api/sessions/${logSessionId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: useDesktopStore.getState().sessionId ?? undefined }),
  });
}

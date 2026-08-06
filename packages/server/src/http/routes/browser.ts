/**
 * Browser routes — direct HTTP access to browser automation actions.
 *
 * POST   /api/browser           — dispatch browser action (open, click, type, etc.)
 * GET    /api/browser/sessions  — list all open browser sessions
 * DELETE /api/browser/:id       — close a browser session
 *
 * All routes require iframe token auth (X-Iframe-Token header).
 */

import { errMessage } from '../../lib/errors.js';
import { errorResponse, jsonResponse, parseJsonBody } from '../utils.js';
import { requireBundledApp, type AppPrincipal } from '../access.js';
import { getHeadlessBrowser } from '../../lib/browser/index.js';
import {
  enforceBrowserGuards,
  isMutatingAction,
  isYaarOriginUrl,
} from '../../features/browser/guards.js';
import { getSessionId, runWithAgentContext } from '../../agents/agent-context.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { runBrowserAction } from '../../features/browser/actions.js';
import type { EndpointMeta } from '../utils.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  { method: 'POST', path: '/api/browser', response: 'json', description: 'Execute browser action' },
  {
    method: 'GET',
    path: '/api/browser/sessions',
    response: 'json',
    description: 'List open browser sessions',
  },
  {
    method: 'DELETE',
    path: '/api/browser/{id}',
    response: 'json',
    description: 'Close a browser session',
  },
  {
    method: 'GET',
    path: '/api/browser/{id}/screenshot',
    response: 'image/webp',
    description: 'Capture browser screenshot',
  },
  {
    method: 'GET',
    path: '/api/browser/{id}/events',
    response: 'text/event-stream',
    description: 'SSE stream for browser session updates',
  },
];

/** Convert a VerbResult to an HTTP Response. */
function verbResultToResponse(result: {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}): Response {
  if (result.isError) {
    const text = result.content.find((c) => c.type === 'text')?.text ?? 'Unknown error';
    return jsonResponse({ ok: false, error: text }, 400);
  }

  const images = result.content.filter((c) => c.type === 'image');
  if (images.length > 0) {
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    return jsonResponse({
      ok: true,
      text,
      images: images.map((img) => ({
        data: img.data,
        mimeType: img.mimeType,
        ...((img as { src?: string }).src && { src: (img as { src?: string }).src }),
      })),
    });
  }

  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  // If the text is valid JSON (from okJson), parse it so clients get clean data
  // instead of a double-serialized string.
  try {
    const parsed = JSON.parse(text);
    return jsonResponse({ ok: true, data: parsed });
  } catch {
    return jsonResponse({ ok: true, data: text });
  }
}

/**
 * Every browser route is behind the `yaar-web` bundle declaration.
 *
 * It used to be "holds *some* valid iframe token" — any app at all, whether or not it
 * declared browser access, could drive the headless browser. And the screenshot and
 * SSE routes below had no check whatsoever, so an app could watch the frames of a
 * browser session it never opened.
 *
 * Screenshots load as `<img src>` and events over `EventSource`; neither can set a
 * header, so those two carry the token as `?__yaar_token=` (see resolvePrincipal).
 */
const requireWeb = (req: Request, url: URL): AppPrincipal | Response =>
  requireBundledApp(req, url, 'yaar-web');

export async function handleBrowserRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/browser')) return null;

  // The public HTTP door is hard-pinned to the headless sandbox (Q4). The user's
  // real browser is reached only through `yaar://session/browser` (session agent).
  const pool = getHeadlessBrowser();

  if (url.pathname === '/api/browser/sessions' && req.method === 'GET') {
    const auth = requireWeb(req, url);
    if (auth instanceof Response) return auth;

    const browsers = pool.getAllSessions();
    if (browsers.size === 0) return jsonResponse({ ok: true, data: [] });

    const items = [...browsers.entries()].map(([bid, s]) => ({
      id: bid,
      url: s.currentUrl,
      title: s.currentTitle || '(no title)',
    }));
    return jsonResponse({ ok: true, data: items });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/browser/')) {
    const id = url.pathname.slice('/api/browser/'.length);
    if (!id) return null;

    const auth = requireWeb(req, url);
    if (auth instanceof Response) return auth;

    const session = pool.getSession(id);
    if (!session) return jsonResponse({ ok: false, error: `No browser with ID ${id}` }, 404);

    if (session.windowId) {
      // The token names the desktop this window is on. There is no agent context on an
      // HTTP route, and closing a window on every desktop that happens to be open is not
      // a reasonable reading of "close mine".
      actionEmitter.emitAction(
        { type: 'window.close', windowId: session.windowId },
        auth.sessionId,
      );
    }
    await pool.closeSession(id);
    return jsonResponse({ ok: true, data: `Browser ${id} closed.` });
  }

  const screenshotMatch = url.pathname.match(/^\/api\/browser\/([a-zA-Z0-9_-]+)\/screenshot$/);
  if (screenshotMatch && req.method === 'GET') {
    const browserId = decodeURIComponent(screenshotMatch[1]);
    const auth = requireWeb(req, url);
    if (auth instanceof Response) return auth;
    try {
      const session = pool.getSession(browserId);
      if (!session) return errorResponse('Browser not found', 404);
      const fresh = url.searchParams.has('fresh');
      const buf = fresh ? await session.screenshot() : session.lastScreenshot;
      if (!buf) return errorResponse('No screenshot available', 404);
      return new Response(buf, {
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Content-Length': buf.length.toString(),
        },
      });
    } catch {
      return errorResponse('Browser not available', 404);
    }
  }

  const eventsMatch = url.pathname.match(/^\/api\/browser\/([a-zA-Z0-9_-]+)\/events$/);
  if (eventsMatch && req.method === 'GET') {
    const browserId = decodeURIComponent(eventsMatch[1]);
    const auth = requireWeb(req, url);
    if (auth instanceof Response) return auth;
    try {
      const session = pool.getSession(browserId);
      if (!session) return errorResponse('Browser session not found', 404);

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const write = (data: string) => {
            try {
              controller.enqueue(encoder.encode(data));
            } catch {
              cleanup();
            }
          };

          const cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            session.off('updated', onUpdate);
            session.off('closed', onClosed);
            // Emit the terminal zero-length chunk on every teardown path — abort,
            // session close, or a failed enqueue. Skipping it drops the socket
            // mid-stream and surfaces as net::ERR_INCOMPLETE_CHUNKED_ENCODING.
            try {
              controller.close();
            } catch {
              // Already closed/errored
            }
          };

          const onUpdate = (update: {
            url: string;
            title: string;
            version: number;
            driving?: boolean;
          }) => {
            write(
              `data: ${JSON.stringify({ ...update, isSelf: isYaarOriginUrl(update.url) })}\n\n`,
            );
          };
          const onClosed = () => cleanup();

          const heartbeat = setInterval(() => {
            write(': heartbeat\n\n');
          }, 30_000);

          session.on('updated', onUpdate);
          session.on('closed', onClosed);
          req.signal.addEventListener('abort', cleanup);

          // Sent last, so cleanup()/heartbeat are already initialized if the very
          // first enqueue throws (otherwise the catch touches them in the TDZ).
          const initial = JSON.stringify({
            url: session.currentUrl,
            title: session.currentTitle,
            version: session.version,
            driving: session.driving,
            isSelf: isYaarOriginUrl(session.currentUrl),
          });
          write(`data: ${initial}\n\n`);
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return errorResponse('Browser not available', 404);
    }
  }

  if (url.pathname === '/api/browser' && req.method === 'POST') {
    const auth = requireWeb(req, url);
    if (auth instanceof Response) return auth;

    const body = await parseJsonBody<Record<string, unknown>>(req);
    if (body instanceof Response) return body;

    const action = body.action as string;
    if (!action) return errorResponse('"action" is required', 400);

    const browserId = (body.browserId as string) ?? '0';

    // Phase 3 consent + self-target guards (no-ops for sandboxed headless tabs).
    const guardedSession = pool.getSession(browserId);
    // The caller's own token, not "whichever session is first in the hub". `getDefault()`
    // is right only while there is one session, and consent prompts raised against the
    // wrong desktop are asked of the wrong person.
    const sessionId = getSessionId() ?? auth.sessionId;
    const guard = await enforceBrowserGuards({
      provider: pool,
      action,
      session: guardedSession,
      sessionId,
    });
    if (!guard.ok) return jsonResponse({ ok: false, error: guard.error }, 403);

    // "Agent is driving this tab" indicator — flag while a mutating action runs.
    const driving = !!guardedSession && isMutatingAction(action);
    if (driving) guardedSession!.setDriving(true);

    try {
      // In the caller's context, as POST /api/verb runs its verbs: the actions this
      // dispatch emits (closing a tab's window, creating one) belong on the desktop whose
      // token authorized the call, and an emit that cannot name a desktop is dropped.
      const result = await runWithAgentContext(
        {
          agentId: `iframe:${auth.appId ?? 'unknown'}`,
          sessionId: auth.sessionId,
          monitorId: auth.monitorId,
          windowId: auth.windowId,
          appId: auth.appId,
        },
        () => runBrowserAction(pool, action, browserId, body),
      );
      return verbResultToResponse(result);
    } catch (err) {
      return jsonResponse({ ok: false, error: `Browser error: ${errMessage(err)}` }, 500);
    } finally {
      if (driving) guardedSession!.setDriving(false);
    }
  }

  return null;
}

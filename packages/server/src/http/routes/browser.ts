/**
 * Browser routes — direct HTTP access to browser automation actions.
 *
 * POST   /api/browser           — dispatch browser action (open, click, type, etc.)
 * GET    /api/browser/sessions  — list all open browser sessions
 * DELETE /api/browser/:id       — close a browser session
 *
 * All routes require iframe token auth (X-Iframe-Token header).
 */

import { MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import { validateIframeToken } from '../iframe-tokens.js';
import { getBrowserPool } from '../../lib/browser/index.js';
import { actionEmitter } from '../../session/action-emitter.js';
import {
  handleCreate,
  handleListTabs,
  handleCloseTab,
  handleOpen,
  handleClick,
  handleType,
  handlePress,
  handleScroll,
  handleNavigate,
  handleHover,
  handleWaitFor,
  handleScreenshot,
  handleExtract,
  handleExtractImages,
  handleHtml,
  handleAnnotate,
  handleRemoveAnnotations,
  handleGetCookies,
  handleSetCookie,
  handleDeleteCookies,
} from '../../features/browser/actions.js';
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
      images: images.map((img) => ({ data: img.data, mimeType: img.mimeType })),
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

function requireAuth(req: Request): ReturnType<typeof validateIframeToken> | Response {
  const token = req.headers.get('X-Iframe-Token');
  const entry = token ? validateIframeToken(token) : null;
  if (!entry) return errorResponse('Invalid or missing iframe token', 403);
  return entry;
}

export async function handleBrowserRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/browser')) return null;

  const pool = getBrowserPool();

  // GET /api/browser/sessions — list all open sessions
  if (url.pathname === '/api/browser/sessions' && req.method === 'GET') {
    const auth = requireAuth(req);
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

  // DELETE /api/browser/:id — close a session
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/browser/')) {
    const id = url.pathname.slice('/api/browser/'.length);
    if (!id) return null;

    const auth = requireAuth(req);
    if (auth instanceof Response) return auth;

    const session = pool.getSession(id);
    if (!session) return jsonResponse({ ok: false, error: `No browser with ID ${id}` }, 404);

    if (session.windowId) {
      actionEmitter.emitAction({ type: 'window.close', windowId: session.windowId });
    }
    await pool.closeSession(id);
    return jsonResponse({ ok: true, data: `Browser ${id} closed.` });
  }

  // GET /api/browser/:id/screenshot — capture screenshot
  const screenshotMatch = url.pathname.match(/^\/api\/browser\/([a-zA-Z0-9_-]+)\/screenshot$/);
  if (screenshotMatch && req.method === 'GET') {
    const browserId = decodeURIComponent(screenshotMatch[1]);
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

  // GET /api/browser/:id/events — SSE stream for browser session updates
  const eventsMatch = url.pathname.match(/^\/api\/browser\/([a-zA-Z0-9_-]+)\/events$/);
  if (eventsMatch && req.method === 'GET') {
    const browserId = decodeURIComponent(eventsMatch[1]);
    try {
      const session = pool.getSession(browserId);
      if (!session) return errorResponse('Browser session not found', 404);

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const write = (data: string) => {
            try {
              controller.enqueue(encoder.encode(data));
            } catch {
              cleanup();
            }
          };

          const initial = JSON.stringify({
            url: session.currentUrl,
            title: session.currentTitle,
            version: session.version,
          });
          write(`data: ${initial}\n\n`);

          const cleanup = () => {
            clearInterval(heartbeat);
            session.off('updated', onUpdate);
            session.off('closed', onClosed);
          };

          const onUpdate = (update: { url: string; title: string; version: number }) => {
            write(`data: ${JSON.stringify(update)}\n\n`);
          };
          const onClosed = () => {
            cleanup();
            try {
              controller.close();
            } catch {
              // Already closed
            }
          };

          const heartbeat = setInterval(() => {
            write(': heartbeat\n\n');
          }, 30_000);

          session.on('updated', onUpdate);
          session.on('closed', onClosed);
          req.signal.addEventListener('abort', cleanup);
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

  // POST /api/browser — dispatch action
  if (url.pathname === '/api/browser' && req.method === 'POST') {
    const auth = requireAuth(req);
    if (auth instanceof Response) return auth;

    let body: Record<string, unknown>;
    try {
      const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
      body = JSON.parse(buf.toString('utf-8'));
    } catch (err) {
      if (err instanceof BodyTooLargeError) return errorResponse('Request body too large', 413);
      return errorResponse('Invalid JSON body', 400);
    }

    const action = body.action as string;
    if (!action) return errorResponse('"action" is required', 400);

    const browserId = (body.browserId as string) ?? '0';

    try {
      let result;
      switch (action) {
        case 'create':
          result = await handleCreate(pool, browserId, body);
          break;
        case 'open':
          result = await handleOpen(pool, browserId, body);
          break;
        case 'click':
          result = await handleClick(pool, browserId, body);
          break;
        case 'type':
          result = await handleType(browserId, body);
          break;
        case 'press':
          result = await handlePress(browserId, body);
          break;
        case 'scroll':
          result = await handleScroll(browserId, body);
          break;
        case 'navigate':
          result = await handleNavigate(browserId, body);
          break;
        case 'hover':
          result = await handleHover(browserId, body);
          break;
        case 'wait_for':
          result = await handleWaitFor(browserId, body);
          break;
        case 'screenshot':
          result = await handleScreenshot(browserId, body);
          break;
        case 'extract':
          result = await handleExtract(browserId, body);
          break;
        case 'extract_images':
          result = await handleExtractImages(browserId, body);
          break;
        case 'html':
          result = await handleHtml(browserId, body);
          break;
        case 'annotate':
          result = await handleAnnotate(browserId);
          break;
        case 'remove_annotations':
          result = await handleRemoveAnnotations(browserId);
          break;
        case 'get_cookies':
          result = await handleGetCookies(browserId, body);
          break;
        case 'set_cookie':
          result = await handleSetCookie(browserId, body);
          break;
        case 'delete_cookies':
          result = await handleDeleteCookies(browserId, body);
          break;
        case 'list_tabs':
          result = await handleListTabs(pool);
          break;
        case 'close_tab':
          result = await handleCloseTab(pool, browserId);
          break;
        default:
          return jsonResponse({ ok: false, error: `Unknown action "${action}"` }, 400);
      }
      return verbResultToResponse(result);
    } catch (err) {
      return jsonResponse(
        { ok: false, error: `Browser error: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  }

  return null;
}

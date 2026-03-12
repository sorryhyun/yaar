/**
 * Browser proxy route — renders pages via headless Chrome and returns content.
 *
 * Unlike /api/fetch (raw HTTP), this uses the CDP BrowserPool to render
 * JS-heavy pages and extract their content after execution.
 *
 * POST /api/browse
 * Body: { url, extract?: "html" | "text" | "screenshot", selector?, waitUntil? }
 * Returns: { ok, url, title, content } or { ok, url, title, screenshot } (base64 WebP)
 */

import { MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse, type EndpointMeta } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import { extractDomain, isDomainAllowed, addAllowedDomain } from '../../features/config/domains.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { validateUrl } from '../../lib/ssrf.js';
import { getBrowserPool } from '../../lib/browser/pool.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/browse',
    response: 'JSON',
    description:
      'Render a page via headless Chrome. Body: `{ url, extract?: "html"|"text"|"screenshot", selector?, waitUntil? }`',
  },
];

const BROWSE_TIMEOUT_MS = 30_000;

interface BrowseRequest {
  url?: string;
  extract?: 'html' | 'text' | 'screenshot';
  selector?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  sessionId?: string;
}

export async function handleBrowseRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/browse' || req.method !== 'POST') {
    return null;
  }

  // Parse request body
  let body: BrowseRequest;
  try {
    const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
    body = JSON.parse(buf.toString('utf-8'));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return errorResponse('Request body too large', 413);
    }
    return errorResponse('Invalid JSON body', 400);
  }

  const targetUrl = body.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return errorResponse('Missing or invalid "url" field', 400);
  }

  // SSRF protection
  try {
    validateUrl(targetUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid URL';
    return errorResponse(message, 400);
  }

  // Check Chrome availability
  const pool = getBrowserPool();
  if (!(await pool.isAvailable())) {
    return errorResponse('Browser not available. Install Chrome/Chromium or set CHROME_PATH.', 503);
  }

  // Domain allowlist check (reuse same flow as /api/fetch)
  const domain = extractDomain(targetUrl);
  if (!(await isDomainAllowed(domain))) {
    const { getSessionHub } = await import('../../session/session-hub.js');
    const hub = getSessionHub();

    let sessionId: string | undefined;
    if (body.sessionId && hub.get(body.sessionId)) {
      sessionId = body.sessionId;
    }
    if (!sessionId) {
      const referer = req.headers.get('referer');
      if (referer) {
        try {
          const refId = new URL(referer).searchParams.get('sessionId') ?? undefined;
          if (refId && hub.get(refId)) sessionId = refId;
        } catch {
          /* invalid referer */
        }
      }
    }
    if (!sessionId) {
      sessionId = hub.getDefault()?.sessionId;
    }
    if (!sessionId) {
      return errorResponse(
        `Domain "${domain}" is not in the allowed list. Add it to curl_allowed_domains.yaml.`,
        403,
      );
    }

    const confirmed = await actionEmitter.showPermissionDialogToSession(
      sessionId,
      'Allow Domain Access',
      `An app wants to browse "${domain}" via headless Chrome.\n\nDo you want to allow this domain?`,
      'http_domain',
      domain,
    );
    if (!confirmed) {
      return errorResponse(`User denied access to domain "${domain}".`, 403);
    }
    await addAllowedDomain(domain);
  }

  // Create a temporary browser session, navigate, extract, then close
  let browserId: string | undefined;
  try {
    const created = await pool.createSession();
    browserId = created.browserId;
    const session = created.session;

    // Set a hard timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Browse timed out')), BROWSE_TIMEOUT_MS),
    );

    const result = await Promise.race([
      (async () => {
        const waitUntil =
          body.extract === 'screenshot' ? 'networkidle' : (body.waitUntil ?? 'load');
        await session.navigate(targetUrl, waitUntil);

        const extract = body.extract ?? 'text';

        if (extract === 'screenshot') {
          const buf = await session.screenshot();
          return jsonResponse({
            ok: true,
            url: session.currentUrl,
            title: session.currentTitle,
            screenshot: buf.toString('base64'),
            format: 'webp',
          });
        }

        if (extract === 'html') {
          // Return rendered HTML of the page (or a selector)
          const content = await session.extractContent(body.selector);
          return jsonResponse({
            ok: true,
            url: content.url,
            title: content.title,
            html: content.fullText, // fullText from extractContent is text; use eval for HTML
            links: content.links,
            forms: content.forms,
          });
        }

        // Default: text extraction
        const content = await session.extractContent(body.selector);
        return jsonResponse({
          ok: true,
          url: content.url,
          title: content.title,
          text: content.fullText,
          links: content.links,
          forms: content.forms,
        });
      })(),
      timeoutPromise,
    ]);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Browse failed';
    if (message.includes('timed out') || message.includes('timeout')) {
      return errorResponse('Browse timed out', 504);
    }
    return errorResponse(message, 502);
  } finally {
    // Always clean up the temporary session
    if (browserId) {
      pool.closeSession(browserId).catch(() => {});
    }
  }
}

/**
 * Browser action implementations extracted from the browser handler.
 *
 * Each function corresponds to one `action` value in the
 * `POST /api/browser` dispatch table.
 */

import type { BrowserProvider } from '../../lib/browser/index.js';
import type { VerbResult } from '../../handlers/uri-registry.js';
import { ok, okJson, okWithImages, error, getActiveSessionId } from '../../handlers/utils.js';
import { resolveSession, formatPageState, findMainContent } from './shared.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { isDomainAllowed, extractDomain, addAllowedDomain } from '../config/domains.js';
import { isYaarOriginUrl, enforceBrowserGuards, isMutatingAction } from './guards.js';
import { getAgentId } from '../../agents/agent-context.js';
import { ServerEventType, type BrowserTabSummary, type OSAction } from '@yaar/shared';
import { handleCreate as handleWindowCreate } from '../window/create.js';

type Payload = Record<string, unknown>;

/**
 * Show a headless tab as a Browser-app window.
 *
 * Goes through the window verb (`features/window/create.ts`) rather than emitting a
 * raw `window.create`, because that verb is the ONE place an iframe token is minted.
 * A raw emit produced a window whose Browser app had no token: every `/api/browser`
 * call from inside it (SSE, screencast, navigation) was refused, and the user saw a
 * tab that had loaded fine sit on "Reconnecting…" — first hit by an app opening a
 * `visible: true` tab for a human login. The verb also derives the app origin and
 * broadcasts correctly whether or not an agent is on the stack.
 *
 * The content is the `yaar://apps/browser` URI, not the `/api/apps/browser/…` path it
 * resolves to. The verb learns which app a window *is* from that URI (`extractAppId`),
 * and the token it mints carries that app's declared bundles. Handed the resolved
 * path, it minted a token for no app at all — no `yaar-web` — so the Browser app's
 * very first `/api/browser/{id}/events` was 403'd and the window stayed blank; the
 * same window came back working after a close/reopen only because window-restore
 * also recognises the `/api/apps/{id}/` path shape.
 *
 * `bid` is caller-chosen and need not be numeric (`'login'`), so the cascade offset
 * falls back to 0 instead of `NaN`.
 */
async function openBrowserWindow(bid: string, isMobile: boolean, title: string): Promise<void> {
  const n = Number(bid);
  const step = Number.isFinite(n) ? n : 0;
  await handleWindowCreate(`browser-${bid}`, {
    title,
    renderer: 'iframe',
    content: `yaar://apps/browser?browserId=${encodeURIComponent(bid)}`,
    x: 80 + step * 30,
    y: 60 + step * 30,
    width: isMobile ? 430 : 900,
    height: isMobile ? 750 : 650,
  });
}

/**
 * Emit a window action via the session-scoped 'browser-action' channel.
 * This ensures the frontend receives the action even when called from
 * HTTP routes (no active agent turn / ToolActionBridge).
 */
function emitBrowserWindowAction(action: OSAction, sessionId?: string): void {
  const sid = sessionId ?? getActiveSessionId();
  if (!sid) return;
  // Only emit via session channel when there's no agent context —
  // during agent turns, ToolActionBridge already handles broadcast.
  if (getAgentId()) return;
  actionEmitter.emit('browser-action', {
    sessionId: sid,
    event: {
      type: ServerEventType.ACTIONS,
      actions: [action],
      agentId: 'system',
    },
  });
}

export async function handleCreate(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const mobile = p.mobile === true;

  const existing = pool.getSession(browserId);
  if (existing) {
    return error(
      `Browser ${browserId} already exists. Use a different browserId or close it first.`,
    );
  }

  const created = await pool.createSession(browserId, { mobile });
  const session = created.session;
  const bid = created.browserId;

  const windowId = `browser-${bid}`;
  session.windowId = windowId;

  if (p.visible !== false) {
    await openBrowserWindow(bid, session.mobile, 'Browser — (new tab)');
  }
  return ok(`[browser:${bid}${session.mobile ? ' mobile' : ''}] Created (about:blank)`);
}

export async function handleListTabs(pool: BrowserProvider): Promise<VerbResult> {
  const browsers = pool.getAllSessions();
  if (browsers.size === 0) return okJson([]);
  const items: BrowserTabSummary[] = [...browsers.entries()].map(([bid, s]) => ({
    id: bid,
    url: s.currentUrl,
    title: s.currentTitle || '(no title)',
    mobile: s.mobile,
    windowId: s.windowId,
    // Flag YAAR's own tab — it's an addressed target like any other, but
    // mutating it via raw automation is refused (use OS Actions instead).
    ...(isYaarOriginUrl(s.currentUrl) ? { isSelf: true as const } : {}),
  }));
  return okJson(items);
}

export async function handleCloseTab(
  pool: BrowserProvider,
  browserId: string,
): Promise<VerbResult> {
  const session = pool.getSession(browserId);
  if (!session) return error(`No browser with ID ${browserId}.`);
  if (session.windowId) {
    const closeAction = { type: 'window.close' as const, windowId: session.windowId };
    actionEmitter.emitAction(closeAction);
    emitBrowserWindowAction(closeAction);
  }
  await pool.closeSession(browserId);
  return ok(`Browser ${browserId} closed.`);
}

export async function handleOpen(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const url = p.url as string;
  if (!url) return error('"url" is required for open.');
  const domain = extractDomain(url);
  if (!domain) return error('Invalid URL');
  if (!(await isDomainAllowed(domain))) {
    // Try to show permission dialog instead of returning a static error
    const sessionId = getActiveSessionId();
    if (!sessionId) {
      return error(
        `Domain "${domain}" not allowed. Use invoke('yaar://config/domains', { domain: "${domain}" }) first.`,
      );
    }
    const confirmed = await actionEmitter.showPermissionDialogToSession(sessionId, {
      title: 'Allow Domain Access',
      message: `The browser wants to navigate to "${domain}".\n\nDo you want to allow this domain?`,
      toolName: 'http_domain',
      context: domain,
    });
    if (!confirmed) {
      return error(`User denied access to domain "${domain}".`);
    }
    await addAllowedDomain(domain);
  }

  const mobile = p.mobile === true;

  // Reuse existing session if one exists with this browserId
  const existing = pool.getSession(browserId);
  let session: typeof existing & {};
  let bid: string;
  if (existing) {
    session = existing;
    bid = browserId;
  } else {
    const created = await pool.createSession(browserId, { mobile });
    session = created.session;
    bid = created.browserId;
  }

  const windowId = `browser-${bid}`;
  session.windowId = windowId;
  const state = await session.navigate(
    url,
    p.waitUntil as 'load' | 'domcontentloaded' | 'networkidle' | undefined,
  );
  if (p.visible !== false && !existing) {
    await openBrowserWindow(bid, session.mobile, `Browser — ${state.title || domain}`);
  }
  return ok(`[browser:${bid}${session.mobile ? ' mobile' : ''}]\n${formatPageState(state)}`);
}

export async function handleClick(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  if (!p.selector && !p.text && (p.x === undefined || p.y === undefined)) {
    return error('Provide "selector", "text", or both "x" and "y".');
  }
  const state = await session.click(
    p.selector as string | undefined,
    p.text as string | undefined,
    p.x as number | undefined,
    p.y as number | undefined,
    p.index as number | undefined,
  );

  // Check if the click opened a new tab (via window.open)
  const adopted = pool.consumeAdoptedTabs();
  if (adopted.length > 0) {
    const tab = adopted[0];
    state.newTab = { browserId: tab.browserId, url: tab.url };
  }

  return ok(formatPageState(state));
}

export async function handleType(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  if (!p.selector) return error('"selector" is required for type.');
  if (!p.text) return error('"text" is required for type.');
  const state = await session.type(p.selector as string, p.text as string);
  return ok(`Typed into ${p.selector}\n\n${formatPageState(state)}`);
}

export async function handlePress(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  if (!p.key) return error('"key" is required for press.');
  const state = await session.press(p.key as string, p.selector as string | undefined);
  return ok(formatPageState(state));
}

export async function handleScroll(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const dir = p.direction as string;
  if (dir !== 'up' && dir !== 'down') return error('"direction" must be "up" or "down".');
  const amount =
    typeof p.amount === 'number' ? Math.max(1, Math.min(p.amount, 100_000)) : undefined;
  const state = await session.scroll(dir, amount);
  return ok(formatPageState(state));
}

export async function handleScrollToBottom(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const result = await session.scrollToBottom({
    maxSteps: typeof p.maxSteps === 'number' ? p.maxSteps : undefined,
    dwellMs: typeof p.dwellMs === 'number' ? p.dwellMs : undefined,
  });
  return okJson(result);
}

export async function handleNavigate(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);

  // Navigate to a URL
  if (p.url) {
    const url = p.url as string;
    const domain = extractDomain(url);
    if (!domain) return error('Invalid URL');
    if (!(await isDomainAllowed(domain))) {
      const sessionId = getActiveSessionId();
      if (!sessionId) {
        return error(
          `Domain "${domain}" not allowed. Use invoke('yaar://config/domains', { domain: "${domain}" }) first.`,
        );
      }
      const confirmed = await actionEmitter.showPermissionDialogToSession(sessionId, {
        title: 'Allow Domain Access',
        message: `The browser wants to navigate to "${domain}".\n\nDo you want to allow this domain?`,
        toolName: 'http_domain',
        context: domain,
      });
      if (!confirmed) {
        return error(`User denied access to domain "${domain}".`);
      }
      await addAllowedDomain(domain);
    }
    const state = await session.navigate(url);
    return ok(formatPageState(state));
  }

  // History navigation (back/forward)
  const dir = p.direction as string;
  if (dir !== 'back' && dir !== 'forward') return error('"direction" must be "back" or "forward".');
  const state = await session.navigateHistory(dir);
  return ok(formatPageState(state));
}

export async function handleHover(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  if (!p.selector && !p.text && (p.x === undefined || p.y === undefined)) {
    return error('Provide "selector", "text", or both "x" and "y".');
  }
  const state = await session.hover(p as Parameters<typeof session.hover>[0]);
  return ok(formatPageState(state));
}

export async function handleWaitFor(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  if (!p.selector) return error('"selector" is required for wait_for.');
  const state = await session.waitForSelector(
    p.selector as string,
    p.timeout as number | undefined,
  );
  return ok(formatPageState(state));
}

export async function handleScreenshot(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const hasRegion =
    p.x0 !== undefined && p.y0 !== undefined && p.x1 !== undefined && p.y1 !== undefined;
  const clip = hasRegion
    ? {
        x: p.x0 as number,
        y: p.y0 as number,
        width: (p.x1 as number) - (p.x0 as number),
        height: (p.y1 as number) - (p.y0 as number),
      }
    : undefined;
  const buffer = await session.screenshot(clip ? { clip } : undefined);
  const label = clip
    ? `Magnified region (${p.x0},${p.y0})→(${p.x1},${p.y1}) @4x:`
    : 'Current browser screenshot:';
  return okWithImages(label, [{ data: buffer.toString('base64'), mimeType: 'image/webp' }]);
}

export async function handleExtract(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const effectiveSelector =
    p.mainContentOnly && !p.selector
      ? await findMainContent(session)
      : (p.selector as string | undefined);
  const content = await session.extractContent(effectiveSelector);
  const maxText = (p.maxTextLength as number) ?? 3000;
  const maxLinks = (p.maxLinks as number) ?? 50;

  let result = `URL: ${content.url}\nTitle: ${content.title}\n`;
  if (content.fullText) {
    const text =
      content.fullText.length > maxText
        ? content.fullText.slice(0, maxText) + '\n... (truncated)'
        : content.fullText;
    result += `\n--- Text ---\n${text}\n`;
  }
  if (content.links.length > 0) {
    const linkLines = content.links
      .slice(0, maxLinks)
      .map((l) => `  [${l.text}](${l.href})`)
      .join('\n');
    result += `\n--- Links (${content.links.length}) ---\n${linkLines}\n`;
    if (content.links.length > maxLinks)
      result += `  ... and ${content.links.length - maxLinks} more\n`;
  }
  if (content.forms.length > 0) {
    const formLines = content.forms.map((f, i) => {
      const fields = f.fields.map((fld) => `    ${fld.name} (${fld.type})`).join('\n');
      return `  Form ${i + 1}: action=${f.action}\n${fields}`;
    });
    result += `\n--- Forms (${content.forms.length}) ---\n${formLines.join('\n')}\n`;
  }
  return ok(result.trim());
}

export async function handleExtractImages(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const effectiveSelector =
    p.mainContentOnly && !p.selector
      ? await findMainContent(session)
      : (p.selector as string | undefined);
  let images = await session.extractImages(effectiveSelector ?? undefined);

  // Apply size filters
  const minW = (p.minWidth as number) || 10;
  const minH = (p.minHeight as number) || 10;
  images = images.filter((img) => img.width >= minW && img.height >= minH);

  // Apply extension filter
  if (Array.isArray(p.extensions) && p.extensions.length > 0) {
    const exts = new Set((p.extensions as string[]).map((e) => e.toLowerCase().replace(/^\./, '')));
    images = images.filter((img) => {
      try {
        const pathname = new URL(img.src).pathname;
        const ext = pathname.split('.').pop()?.toLowerCase();
        return ext && exts.has(ext);
      } catch {
        return false;
      }
    });
  }

  if (images.length === 0) return ok('No images found.');

  // Separate images that were successfully captured vs cross-origin failures
  const captured = images.filter((img) => img.dataUrl);
  const crossOrigin = images.filter((img) => !img.dataUrl);

  let text = `Found ${images.length} image(s).`;
  if (crossOrigin.length > 0) {
    text += `\n${crossOrigin.length} cross-origin image(s) could not be captured:`;
    for (const img of crossOrigin) {
      text += `\n  - ${img.src} (${img.width}x${img.height})${img.alt ? ` alt="${img.alt}"` : ''}`;
    }
  }
  if (captured.length > 0) {
    text += `\n${captured.length} image(s) extracted:`;
    for (const img of captured) {
      text += `\n  - ${img.src} (${img.width}x${img.height})${img.alt ? ` alt="${img.alt}"` : ''}`;
    }
  }

  if (captured.length === 0) return ok(text);

  return {
    content: [
      { type: 'text' as const, text },
      ...captured.map((img) => ({
        type: 'image' as const,
        src: img.src,
        data: img.dataUrl!.replace(/^data:image\/\w+;base64,/, ''),
        mimeType: 'image/png',
      })),
    ],
  };
}

export async function handleGetCookies(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const urls = p.urls as string[] | undefined;
  const cookies = await session.getCookies(urls);
  return okJson(cookies);
}

export async function handleSetCookie(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  if (!p.name) return error('"name" is required for set_cookie.');
  if (p.value === undefined) return error('"value" is required for set_cookie.');
  const success = await session.setCookie({
    name: p.name as string,
    value: p.value as string,
    domain: p.domain as string | undefined,
    path: p.path as string | undefined,
    expires: p.expires as number | undefined,
    httpOnly: p.httpOnly as boolean | undefined,
    secure: p.secure as boolean | undefined,
    sameSite: p.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
    url: p.url as string | undefined,
  });
  return success ? ok('Cookie set.') : error('Failed to set cookie.');
}

export async function handleDeleteCookies(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  if (!p.name) return error('"name" is required for delete_cookies.');
  await session.deleteCookies({
    name: p.name as string,
    domain: p.domain as string | undefined,
    path: p.path as string | undefined,
    url: p.url as string | undefined,
  });
  return ok(`Cookie "${p.name}" deleted.`);
}

export async function handleEvaluate(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  if (!p.expression) return error('"expression" is required for evaluate.');
  // `awaitPromise` makes a page-side sleep count against this budget. Capped at
  // 120s to stay inside the SDK's own fetch abort.
  const raw = typeof p.timeoutMs === 'number' ? p.timeoutMs : undefined;
  const timeoutMs = raw === undefined ? undefined : Math.max(1_000, Math.min(raw, 120_000));
  const result = await session.evaluate(p.expression as string, timeoutMs);
  return okJson((result as object) ?? null);
}

export async function handleHtml(
  pool: BrowserProvider,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const selector = p.selector as string | undefined;
  const opts = { outerHTML: p.outerHTML === true };
  if (p.includeMeta === true) {
    return okJson(await session.getHtmlWithMeta(selector, opts));
  }
  return ok(await session.getHtml(selector, opts));
}

export async function handleAnnotate(
  pool: BrowserProvider,
  browserId: string,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const result = await session.annotateElements();
  return okJson(result);
}

export async function handleRemoveAnnotations(
  pool: BrowserProvider,
  browserId: string,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  await session.removeAnnotations();
  return ok('Annotations removed.');
}

/**
 * Turn the app-facing block rules into `Network.setBlockedURLs` wildcard
 * patterns. A host rule is a suffix rule: `doubleclick.net` must catch
 * `ad.doubleclick.net` but not `notdoubleclick.net`, hence two patterns rather
 * than `*doubleclick.net*`. A URL-pattern rule is a plain substring.
 */
export function compileBlockPatterns(rules: {
  hosts?: string[];
  urlPatterns?: string[];
  patterns?: string[];
}): string[] {
  const out = new Set<string>();
  for (const raw of rules.hosts ?? []) {
    const host = String(raw)
      .trim()
      .replace(/^\*?\.?/, '')
      .toLowerCase();
    if (!host) continue;
    out.add(`*://${host}/*`);
    out.add(`*://*.${host}/*`);
  }
  for (const raw of rules.urlPatterns ?? []) {
    const sub = String(raw).trim();
    if (sub) out.add(`*${sub}*`);
  }
  for (const raw of rules.patterns ?? []) {
    const pat = String(raw).trim();
    if (pat) out.add(pat);
  }
  return [...out];
}

/**
 * Request blocking — the server half of the Browser app's shield (issue #94).
 * Provider-wide on purpose: an ad's popup is a new tab, and a per-tab rule set
 * would leave that tab open with nothing blocked until someone noticed it.
 * `browserId` is accepted and ignored so the verb reads like its siblings.
 */
export async function handleSetRequestBlocking(
  pool: BrowserProvider,
  p: Payload,
): Promise<VerbResult> {
  const enabled = p.enabled !== false;
  const rules = (p.rules ?? {}) as {
    hosts?: string[];
    urlPatterns?: string[];
    patterns?: string[];
  };
  const blockedUrls = enabled ? compileBlockPatterns(rules) : [];
  const shield = await pool.setShield({ blockedUrls });
  return okJson({ enabled: shield.blockedUrls.length > 0, ruleCount: shield.blockedUrls.length });
}

export async function handleGetRequestBlockStats(
  pool: BrowserProvider,
  browserId: string,
): Promise<VerbResult> {
  const session = resolveSession(pool, browserId);
  const stats = session.getRequestBlockStats();
  return okJson({ ...stats, enabled: pool.getShield().blockedUrls.length > 0 });
}

/**
 * Init script — runs before any page script, on every navigation, in every tab
 * (provider-wide, like the blocklist). The only place a `window.open` override
 * wins the race against a popunder that binds on load. Empty string clears.
 */
export async function handleSetInitScript(pool: BrowserProvider, p: Payload): Promise<VerbResult> {
  if (typeof p.script !== 'string') return error('"script" is required for set_init_script.');
  const shield = await pool.setShield({ initScript: p.script });
  return okJson({ installed: shield.initScript.length > 0 });
}

/**
 * Shared action dispatcher — the single switch table that both browser doors
 * use. The caller passes the provider instance (headless for `/api/browser`,
 * the user's real Chrome for `yaar://session/browser`) plus the parsed action
 * payload. Consent / self-target guards and the "driving" indicator are applied
 * by the caller around this switch (see `runGuardedBrowserAction`).
 */
export async function runBrowserAction(
  pool: BrowserProvider,
  action: string,
  browserId: string,
  body: Payload,
): Promise<VerbResult> {
  switch (action) {
    case 'create':
      return handleCreate(pool, browserId, body);
    case 'open':
      return handleOpen(pool, browserId, body);
    case 'click':
      return handleClick(pool, browserId, body);
    case 'type':
      return handleType(pool, browserId, body);
    case 'press':
      return handlePress(pool, browserId, body);
    case 'scroll':
      return handleScroll(pool, browserId, body);
    case 'scroll_to_bottom':
      return handleScrollToBottom(pool, browserId, body);
    case 'navigate':
      return handleNavigate(pool, browserId, body);
    case 'hover':
      return handleHover(pool, browserId, body);
    case 'wait_for':
      return handleWaitFor(pool, browserId, body);
    case 'screenshot':
      return handleScreenshot(pool, browserId, body);
    case 'extract':
      return handleExtract(pool, browserId, body);
    case 'extract_images':
      return handleExtractImages(pool, browserId, body);
    case 'evaluate':
      return handleEvaluate(pool, browserId, body);
    case 'html':
      return handleHtml(pool, browserId, body);
    case 'annotate':
      return handleAnnotate(pool, browserId);
    case 'remove_annotations':
      return handleRemoveAnnotations(pool, browserId);
    case 'get_cookies':
      return handleGetCookies(pool, browserId, body);
    case 'set_cookie':
      return handleSetCookie(pool, browserId, body);
    case 'delete_cookies':
      return handleDeleteCookies(pool, browserId, body);
    case 'list_tabs':
      return handleListTabs(pool);
    case 'close_tab':
      return handleCloseTab(pool, browserId);
    case 'set_request_blocking':
      return handleSetRequestBlocking(pool, body);
    case 'get_request_block_stats':
      return handleGetRequestBlockStats(pool, browserId);
    case 'set_init_script':
      return handleSetInitScript(pool, body);
    default:
      return error(`Unknown action "${action}".`);
  }
}

/**
 * Apply the Phase-3 consent + self-target guards and the "driving" indicator,
 * then run the action against `pool`. Returns a `VerbResult` (guard denials
 * surface as `isError`). Shared by `yaar://session/browser`; the HTTP route
 * keeps its own wrapper so it can map a guard denial to HTTP 403.
 *
 * `allowSelfTarget` lets the session-agent door drive YAAR's own tab (it's the
 * user's deputy); the HTTP route never sets it, so self-target stays refused.
 */
export async function runGuardedBrowserAction(
  pool: BrowserProvider,
  action: string,
  body: Payload,
  sessionId?: string,
  allowSelfTarget?: boolean,
): Promise<VerbResult> {
  const browserId = (body.browserId as string) ?? '0';
  const session = pool.getSession(browserId);
  const guard = await enforceBrowserGuards({
    provider: pool,
    action,
    session,
    sessionId,
    allowSelfTarget,
  });
  if (!guard.ok) return error(guard.error);

  const driving = !!session && isMutatingAction(action);
  if (driving) session!.setDriving(true);
  try {
    return await runBrowserAction(pool, action, browserId, body);
  } finally {
    if (driving) session!.setDriving(false);
  }
}

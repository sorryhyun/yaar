/**
 * Browser action implementations extracted from the browser handler.
 *
 * Each function corresponds to one `action` value in the
 * `POST /api/browser` dispatch table.
 */

import type { BrowserPool } from '../../lib/browser/index.js';
import type { VerbResult } from '../../handlers/uri-registry.js';
import { ok, okJson, okWithImages, error } from '../../handlers/utils.js';
import { resolveSession, formatPageState, findMainContent } from './shared.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { isDomainAllowed, extractDomain, addAllowedDomain } from '../config/domains.js';
import { getAgentId, getSessionId } from '../../agents/agent-context.js';
import { getSessionHub } from '../../session/session-hub.js';
import { ServerEventType, type OSAction } from '@yaar/shared';

type Payload = Record<string, unknown>;

/** Resolve session ID from agent context, falling back to the default session. */
function resolveSessionId(): string | undefined {
  const id = getSessionId();
  if (id) return id;
  return getSessionHub().getDefault()?.sessionId;
}

/**
 * Emit a window action via the session-scoped 'browser-action' channel.
 * This ensures the frontend receives the action even when called from
 * HTTP routes (no active agent turn / ToolActionBridge).
 */
function emitBrowserWindowAction(action: OSAction, sessionId?: string): void {
  const sid = sessionId ?? resolveSessionId();
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
  pool: BrowserPool,
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
    const isMobile = session.mobile;
    const sessionId = resolveSessionId();
    const windowAction = {
      type: 'window.create' as const,
      windowId,
      title: 'Browser — (new tab)',
      bounds: {
        x: 80 + Number(bid) * 30,
        y: 60 + Number(bid) * 30,
        w: isMobile ? 430 : 900,
        h: isMobile ? 750 : 650,
      },
      content: {
        renderer: 'iframe' as const,
        data: `/api/apps/browser/dist/index.html?browserId=${bid}`,
      },
    };
    await actionEmitter.emitActionWithFeedback(windowAction, 3000, sessionId);
    emitBrowserWindowAction(windowAction, sessionId);
  }
  return ok(`[browser:${bid}${session.mobile ? ' mobile' : ''}] Created (about:blank)`);
}

export async function handleListTabs(pool: BrowserPool): Promise<VerbResult> {
  const browsers = pool.getAllSessions();
  if (browsers.size === 0) return okJson([]);
  const items = [...browsers.entries()].map(([bid, s]) => ({
    id: bid,
    url: s.currentUrl,
    title: s.currentTitle || '(no title)',
    mobile: s.mobile,
    windowId: s.windowId,
  }));
  return okJson(items);
}

export async function handleCloseTab(pool: BrowserPool, browserId: string): Promise<VerbResult> {
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
  pool: BrowserPool,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const url = p.url as string;
  if (!url) return error('"url" is required for open.');
  const domain = extractDomain(url);
  if (!domain) return error('Invalid URL');
  if (!(await isDomainAllowed(domain))) {
    // Try to show permission dialog instead of returning a static error
    const sessionId = resolveSessionId();
    if (!sessionId) {
      return error(
        `Domain "${domain}" not allowed. Use invoke('yaar://config/domains', { domain: "${domain}" }) first.`,
      );
    }
    const confirmed = await actionEmitter.showPermissionDialogToSession(
      sessionId,
      'Allow Domain Access',
      `The browser wants to navigate to "${domain}".\n\nDo you want to allow this domain?`,
      'http_domain',
      domain,
    );
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
    const isMobile = session.mobile;
    const sessionId = resolveSessionId();
    const windowAction = {
      type: 'window.create' as const,
      windowId,
      title: `Browser — ${state.title || domain}`,
      bounds: {
        x: 80 + Number(bid) * 30,
        y: 60 + Number(bid) * 30,
        w: isMobile ? 430 : 900,
        h: isMobile ? 750 : 650,
      },
      content: {
        renderer: 'iframe' as const,
        data: `/api/apps/browser/dist/index.html?browserId=${bid}`,
      },
    };
    await actionEmitter.emitActionWithFeedback(windowAction, 3000, sessionId);
    emitBrowserWindowAction(windowAction, sessionId);
  }
  return ok(`[browser:${bid}${session.mobile ? ' mobile' : ''}]\n${formatPageState(state)}`);
}

export async function handleClick(
  pool: BrowserPool,
  browserId: string,
  p: Payload,
): Promise<VerbResult> {
  const session = resolveSession(browserId);
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

export async function handleType(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  if (!p.selector) return error('"selector" is required for type.');
  if (!p.text) return error('"text" is required for type.');
  const state = await session.type(p.selector as string, p.text as string);
  return ok(`Typed into ${p.selector}\n\n${formatPageState(state)}`);
}

export async function handlePress(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  if (!p.key) return error('"key" is required for press.');
  const state = await session.press(p.key as string, p.selector as string | undefined);
  return ok(formatPageState(state));
}

export async function handleScroll(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  const dir = p.direction as string;
  if (dir !== 'up' && dir !== 'down') return error('"direction" must be "up" or "down".');
  const state = await session.scroll(dir);
  return ok(formatPageState(state));
}

export async function handleNavigate(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);

  // Navigate to a URL
  if (p.url) {
    const url = p.url as string;
    const domain = extractDomain(url);
    if (!domain) return error('Invalid URL');
    if (!(await isDomainAllowed(domain))) {
      const sessionId = resolveSessionId();
      if (!sessionId) {
        return error(
          `Domain "${domain}" not allowed. Use invoke('yaar://config/domains', { domain: "${domain}" }) first.`,
        );
      }
      const confirmed = await actionEmitter.showPermissionDialogToSession(
        sessionId,
        'Allow Domain Access',
        `The browser wants to navigate to "${domain}".\n\nDo you want to allow this domain?`,
        'http_domain',
        domain,
      );
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

export async function handleHover(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  if (!p.selector && !p.text && (p.x === undefined || p.y === undefined)) {
    return error('Provide "selector", "text", or both "x" and "y".');
  }
  const state = await session.hover(p as Parameters<typeof session.hover>[0]);
  return ok(formatPageState(state));
}

export async function handleWaitFor(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  if (!p.selector) return error('"selector" is required for wait_for.');
  const state = await session.waitForSelector(
    p.selector as string,
    p.timeout as number | undefined,
  );
  return ok(formatPageState(state));
}

export async function handleScreenshot(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
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

export async function handleExtract(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
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

export async function handleExtractImages(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
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

export async function handleGetCookies(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  const urls = p.urls as string[] | undefined;
  const cookies = await session.getCookies(urls);
  return okJson(cookies);
}

export async function handleSetCookie(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
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

export async function handleDeleteCookies(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  if (!p.name) return error('"name" is required for delete_cookies.');
  await session.deleteCookies({
    name: p.name as string,
    domain: p.domain as string | undefined,
    path: p.path as string | undefined,
    url: p.url as string | undefined,
  });
  return ok(`Cookie "${p.name}" deleted.`);
}

export async function handleEvaluate(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  if (!p.expression) return error('"expression" is required for evaluate.');
  const result = await session.evaluate(p.expression as string);
  return okJson((result as object) ?? null);
}

export async function handleHtml(browserId: string, p: Payload): Promise<VerbResult> {
  const session = resolveSession(browserId);
  const html = await session.getHtml(p.selector as string | undefined);
  return ok(html);
}

export async function handleAnnotate(browserId: string): Promise<VerbResult> {
  const session = resolveSession(browserId);
  const result = await session.annotateElements();
  return okJson(result);
}

export async function handleRemoveAnnotations(browserId: string): Promise<VerbResult> {
  const session = resolveSession(browserId);
  await session.removeAnnotations();
  return ok('Annotations removed.');
}

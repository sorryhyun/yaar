/**
 * Shared helpers for window feature logic.
 */

import type { VerbResult } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getAppMeta } from '../apps/discovery.js';
import { error } from '../../handlers/utils.js';
import { storageUriForPath } from '../../http/access.js';
import { parseContentPath } from '../../lib/yaar-uri-server.js';
import type { WindowVariant } from '@yaar/shared';

/**
 * Name the `yaar://` URI of an iframe's own document, when storage is what serves it.
 *
 * The browser fetches this URL under the window's iframe token, so it passes through
 * the same gate as any other storage read — and it is parsed here the same way the
 * gate parses it (`parseContentPath` over a decoded pathname), so the URI granted is
 * the URI checked. Returns undefined for content storage does not serve — an external
 * site, or a bundled app under `/api/apps/`, which is not permission-gated at all.
 *
 * Lives here rather than in `create.ts` because the restore path needs the same answer:
 * a server restart replays the `window.create` with its content path intact, so the one
 * piece of window-scoped authority a restart *can* recover is recovered by calling this
 * (`LiveSession`). Everything else a caller granted was never written to the log.
 */
export function storageDocumentUri(data: unknown): string | undefined {
  if (typeof data !== 'string') return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(data.split('?')[0]);
  } catch {
    return undefined; // malformed escape — names no file
  }
  const parsed = parseContentPath(decoded);
  if (parsed?.authority !== 'storage') return undefined;
  return storageUriForPath(parsed.path) ?? undefined;
}

/** Format a window ID as a yaar:// resource URI. */
export function formatWindowRef(windowId: string): string {
  return `yaar://windows/${windowId}`;
}

/** Derive a window ID from payload fields. */
export function deriveWindowId(appId?: string, name?: string, title?: string): string {
  if (appId) return appId;
  const source = name ?? title ?? '';
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `win-${Date.now().toString(36)}`;
}

/**
 * Find a free window id, given one that may already be taken.
 *
 * A derived id is a slug of the title (or the appId), so two creates that merely
 * *look alike* — two "Generated Image Preview" windows — collide. Assigning the
 * collision to the same id let the second create destroy the first: the store
 * does `windows[key] = window`, so the earlier window vanished without even the
 * close path running. Stepping to `{id}-2` opens a second window instead.
 *
 * Bounded: after 99 the id carries a timestamp rather than looping forever.
 */
export function allocateWindowId(windowState: WindowStateRegistry, desired: string): string {
  if (!windowState.hasWindow(desired)) return desired;
  for (let n = 2; n <= 99; n++) {
    const candidate = `${desired}-${n}`;
    if (!windowState.hasWindow(candidate)) return candidate;
  }
  return `${desired}-${Date.now().toString(36)}`;
}

/** Check that a window exists, returning an error result if not. */
export function requireWindowExists(
  windowState: WindowStateRegistry,
  windowId: string,
): VerbResult | null {
  if (!windowState.hasWindow(windowId)) return error(`Window "${windowId}" does not exist.`);
  return null;
}

/** Check that a window is not locked by another agent. Returns error if locked. */
export function requireWindowUnlocked(
  windowState: WindowStateRegistry,
  windowId: string,
  agentId: string | undefined,
): VerbResult | null {
  const lockedBy = windowState.isLockedByOther(windowId, agentId);
  if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
  return null;
}

/** Extract common window info fields (variant, dockEdge). */
export function formatWindowFlags(win: {
  appProtocol?: boolean;
  variant?: string;
  dockEdge?: string;
}) {
  return {
    ...(win.appProtocol ? { appProtocol: true } : {}),
    ...(win.variant && win.variant !== 'standard' ? { variant: win.variant } : {}),
    ...(win.dockEdge ? { dockEdge: win.dockEdge } : {}),
  };
}

/** Extract OS Action overrides from app metadata. */
export function getAppMetaOverrides(
  appMeta: Awaited<ReturnType<typeof getAppMeta>>,
): Record<string, unknown> {
  if (!appMeta) return {};
  return {
    ...(appMeta.variant ? { variant: appMeta.variant as WindowVariant } : {}),
    ...(appMeta.dockEdge ? { dockEdge: appMeta.dockEdge as 'top' | 'bottom' } : {}),
    ...(appMeta.frameless ? { frameless: true } : {}),
    ...(appMeta.windowStyle ? { windowStyle: appMeta.windowStyle } : {}),
  };
}

/**
 * Emit an action the frontend only answers in order to *refuse* it, and return an error
 * result if it does.
 *
 * This is a veto, not an acknowledgement: closing or updating a window succeeds locally
 * the moment the action is applied, and the frontend pushes feedback only when it will
 * not apply it — the window is locked by another agent. So silence within the deadline
 * genuinely means "no objection", and that is the one place in this codebase where a
 * timeout may be read as success.
 *
 * It is spelled out here because it is indistinguishable, at the call site, from the bug
 * this slice removes: `emitActionWithFeedback` used to answer both "no veto" and "the
 * iframe never rendered" with the same `null`, and `window.create` read that null as a
 * window it had successfully put on the screen.
 */
export async function emitActionChecked(
  osAction: Parameters<typeof actionEmitter.emitActionWithFeedback>[0],
  timeout: number,
  errorMsg: string,
): Promise<VerbResult | null> {
  const outcome = await actionEmitter.emitActionWithFeedback(osAction, timeout);
  if (outcome.ok && !outcome.value.success) return error(errorMsg);
  return null;
}

/**
 * Stamping the scoped handle onto an action on its way to the frontend.
 *
 * `WindowHandleMap` owns the *format* of a handle; this module owns the one rule about
 * **when** to ask it. Three paths emit window-bearing actions — the agent path
 * (`ToolActionBridge`), the non-agent path (`LiveSession.handleEmittedAction`, for the
 * iframe verb proxy and HTTP routes), and launch hooks — and each used to carry its own
 * copy of the rule. Only one copy had it right, which is how the incident below reached
 * production on the other two.
 *
 * The rule, and why it is not "just resolve the handle":
 *
 * - **`window.create` must be resolved *after* the action is applied.** Create is what
 *   *mints* the handle, so before it there is nothing to resolve and the lookup answers
 *   with the raw id. Sending that raw id is not cosmetic: the frontend has no monitor to
 *   key the new window by either, so it falls back to whichever monitor that tab is
 *   *looking at* (`applyWindowAction`), and on a two-monitor desktop that is routinely
 *   the wrong one. The two registries then hold the same window under different keys
 *   forever — the server says `0/preview`, the tab says `1/preview` — every later
 *   app_query resolves to no DOM element and reports "Window element not found", and
 *   nothing short of closing and re-creating the window repairs it.
 * - **Everything else must be resolved *before*.** `window.close` removes the handle, so
 *   a lookup afterwards answers with the raw id — which is what went out on the wire, and
 *   to every subscriber, for every close an app performed. The frontend then had to guess
 *   the monitor back by scanning its keys for a matching suffix, and with the same app open
 *   on two monitors it could guess wrong and close the other one.
 *
 * Hence {@link windowHandleFor} takes both answers: `priorHandle` (what the resolver said
 * before the registry was updated, if the caller is in a position to have asked) and the
 * resolver itself, asked again now. A caller with only one phase passes no `priorHandle`
 * and gets the post-apply answer, which is correct for a create and best-effort for the
 * rest — better than the raw id either way, because an ambiguous raw id resolves to
 * `undefined` and falls back to itself rather than guessing a monitor.
 */

import type { OSAction } from '@yaar/shared';

/**
 * Raw window id + the acting monitor → the scoped handle, or `undefined`/the id itself
 * when there is no handle to give.
 *
 * Two implementations are passed in practice: `WindowHandleMap.resolve` (a pure lookup)
 * and `ContextPool`'s resolve-or-register wrapper, which mints the handle a monitor agent's
 * new window needs. Both fit this signature; neither is this module's business.
 */
export type WindowHandleResolver = (rawWindowId: string, monitorId?: string) => string | undefined;

/** The raw window id an action names, or undefined for actions that name no window. */
export function actionWindowId(action: OSAction): string | undefined {
  return (action as { windowId?: string }).windowId;
}

/**
 * The handle a window-bearing action should carry on the wire.
 *
 * Call *after* the action has been applied to the window registry, passing the handle the
 * same resolver gave *before* as `priorHandle` when there was a before to ask. Returns
 * `undefined` only for an action that names no window; otherwise it always answers with
 * something addressable, falling back to the raw id.
 */
export function windowHandleFor(
  action: OSAction,
  resolve: WindowHandleResolver,
  monitorId: string | undefined,
  priorHandle?: string,
): string | undefined {
  const raw = actionWindowId(action);
  if (!raw) return undefined;
  // Create resolves post-apply and ignores any prior answer; see the header.
  if (action.type === 'window.create') return resolve(raw, monitorId) ?? raw;
  return priorHandle ?? resolve(raw, monitorId) ?? raw;
}

/**
 * `action` as it should go out: its `windowId` replaced by the scoped handle, and the
 * `requestId` carried through when one was given.
 *
 * The requestId belongs here because it is the other field a caller can silently drop on
 * the way out. An action awaiting feedback is only answerable if the frontend knows which
 * request to answer — `window.capture` reads the id off the action itself and skips the
 * capture without one — which is why devtools could open a preview and never screenshot
 * it: the request went out, nothing came back, and the read timed out into "no screenshot".
 *
 * Returns the original object when there is nothing to change, so an action that needs no
 * stamping is not needlessly copied.
 */
export function stampWindowHandle(
  action: OSAction,
  handle: string | undefined,
  requestId?: string,
): OSAction {
  const raw = actionWindowId(action);
  const patch = {
    ...(handle && handle !== raw ? { windowId: handle } : {}),
    ...(requestId ? { requestId } : {}),
  };
  if (Object.keys(patch).length === 0) return action;
  return { ...action, ...patch } as OSAction;
}

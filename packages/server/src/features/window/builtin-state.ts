/**
 * The state keys a *window* answers for — `__content`, `__screenshot`, `__console` — and the
 * capture round trip behind `__screenshot`.
 *
 * Two doors answer them. The verbs door (`handlers/window.ts`) serves
 * `read('yaar://windows/{id}/state/{key}')` and `app_query`; the app agent's `query` tool
 * (`mcp/app-agent/`) serves the same keys for its own window, and for a window of an app its
 * `controls` names. They lived in the verbs handler alone, so an app agent — and an outside
 * agent borrowing one through a shared window (`external-share.ts`) — asked the *app* for
 * `__screenshot`, and the app had never heard of it: the one agent driving a window was the
 * one agent that could not look at it.
 */

import type { SoftKeyboard } from '@yaar/shared';
import { captureForModel } from '@yaar/lib/image';
import { error, okJsonResource, type VerbResult } from '../../lib/verb-result.js';
import {
  hasLineFilter,
  applyReadOptionsToValue,
  type ReadOptions,
} from '../../lib/read-options.js';
import { getActiveSessionId } from '../../handlers/utils.js';
import type { WindowState, WindowStateRegistry } from '../../session/window-state.js';
import { clientAwayNote } from '../../session/client-presence.js';
import { buildWindowResourceUri } from '../../lib/yaar-uri-server.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { valueOf } from '../../session/pending-store.js';

/**
 * The state keys a *window* answers for, as opposed to the ones the app inside it answers.
 *
 * `__console` is the precedent: a key that has always been addressable, answered without the
 * app's involvement, and documented nowhere but in one param description. Making the set
 * explicit is what lets `list` on a window with no protocol return what it *has* instead of an
 * error about what it lacks — a markdown window is not a failed collection, it is a window
 * whose only addressable value is its content.
 *
 * `__content` and `__screenshot` are answered here, from the registry and from a capture round
 * trip; `__console` is listed here and dispatched to the app path, since the injected
 * app-protocol script is what holds the buffer. The `__` prefix is reserved for this: an app
 * declaring one of these names is shadowed, not merged, because a window's own content is not
 * something the app inside it gets to redefine.
 */
export const BUILTIN_STATE = {
  __content: {
    description:
      "This window's content, exactly as the registry holds it — no capture, no round trip " +
      'to the app. This is the field a bare read omits when it returns a screenshot instead.',
    iframeOnly: false,
  },
  __screenshot: {
    description:
      'A capture of what this window is showing right now. Iframe windows only — it is what ' +
      'a bare read of one returns alongside its metadata.',
    iframeOnly: true,
  },
  __console: {
    description:
      "The iframe's captured console output. Answered by the injected app-protocol script, so " +
      'it works before — and without — the app ever registering.',
    iframeOnly: true,
  },
} as const;

export type BuiltinStateKey = keyof typeof BUILTIN_STATE;

export function isBuiltinStateKey(key: string): key is BuiltinStateKey {
  return Object.prototype.hasOwnProperty.call(BUILTIN_STATE, key);
}

/** The built-in keys that apply to one window — two of the three need an iframe to answer. */
export function builtinStateFor(win: WindowState): BuiltinStateKey[] {
  const isIframe = win.content.renderer === 'iframe';
  return (Object.keys(BUILTIN_STATE) as BuiltinStateKey[]).filter(
    (key) => isIframe || !BUILTIN_STATE[key].iframeOnly,
  );
}

/**
 * The sentence that has to sit next to a degraded screenshot.
 *
 * A `__screenshot` read answers with the image alone, so there is no JSON field to
 * hang the caveat on — and an image that quietly omits a region is believed. The
 * text block leads the response for the same reason.
 */
function describeCaptureDegraded(notes: string[]): string {
  return (
    'This screenshot is incomplete — the capture succeeded but knows it left ' +
    'content out:\n' +
    notes.map((n) => `- ${n}`).join('\n') +
    '\nDo not read a blank region here as "the app rendered nothing there". An app ' +
    'that paints imperatively can supply its own image via defineApp({ onCapture }).'
  );
}

/**
 * The sentence that has to sit next to a screenshot taken with the soft keyboard up.
 *
 * On a phone the window is resized to fit above the keyboard, so its picture is squished —
 * and a squished picture of an app, with nothing saying why, is read as that app's layout
 * being broken. The agent that reads it then "fixes" CSS that was fine (#125).
 */
export function describeKeyboard(keyboard: SoftKeyboard): string {
  const { visible, full } = keyboard;
  return (
    `The phone's soft keyboard was open when this was captured: only ${visible.w}×${visible.h} ` +
    `of its ${full.w}×${full.h} screen was visible above it, and the window was shrunk to ` +
    'fit. A squished or cut-off layout here is the keyboard, not a layout bug — do not ' +
    'change the app for it.'
  );
}

/**
 * Ask the frontend for a capture of this window.
 *
 * Addressed by the *window's* monitor, never the caller's: an iframe-SDK read (agentId
 * `iframe:*`, e.g. devtools' viewPreview) carries no monitor of its own, so a capture sent
 * out on the caller's monitor goes unaddressed and its feedback never comes back — which
 * left the one tool that builds a window as the only tool that could not look at it.
 *
 * A failure names its cause: a capture that failed because the canvas was tainted is
 * unfixable by retrying, while one that timed out may well succeed on the next call.
 * Reported as the same empty result, both looked like "it may not have painted yet".
 */
export async function captureWindow(
  windowState: WindowStateRegistry,
  win: WindowState,
): Promise<{
  imageData?: string;
  captureFailure?: string;
  captureError?: string;
  captureDegraded?: string[];
  keyboard?: SoftKeyboard;
}> {
  const outcome = await actionEmitter.emitActionWithFeedback(
    { type: 'window.capture', windowId: win.id },
    5000,
    undefined,
    windowState.getMonitorForWindow(win.id),
  );
  const feedback = valueOf(outcome);
  if (feedback?.success && feedback.imageData) {
    // A capture that succeeded while omitting content says so here, or the
    // omission reaches the reader as an ordinary picture. See
    // RenderingFeedbackEvent.captureDegraded.
    const degraded = feedback.captureDegraded;
    return {
      imageData: feedback.imageData,
      ...(degraded && degraded.length > 0 ? { captureDegraded: degraded } : {}),
      ...(feedback.keyboard ? { keyboard: feedback.keyboard } : {}),
    };
  }
  if (!feedback) return { captureFailure: 'no-response' };
  return { captureFailure: feedback.captureFailure, captureError: feedback.error };
}

/**
 * `read` of a built-in state key.
 *
 * Returns null only for `__console`, whose buffer lives in the injected script — that one
 * falls through to the app path like any declared key. The other two are answered here, and
 * deliberately *before* the app is consulted: a markdown window has no app to ask, and an
 * iframe whose app never registered would otherwise wait out the readiness deadline to be
 * told it cannot answer for a value the OS was holding all along.
 */
export async function readBuiltinState(
  windowState: WindowStateRegistry,
  windowId: string,
  win: WindowState,
  key: BuiltinStateKey,
  readOptions?: ReadOptions,
): Promise<VerbResult | null> {
  if (!builtinStateFor(win).includes(key)) {
    return error(
      `"${key}" needs an iframe; window "${windowId}" is a ${win.content.renderer} window. ` +
        `list("yaar://windows/${windowId}") shows what this one has.`,
    );
  }

  if (key === '__content') {
    const uri = buildWindowResourceUri(windowId, 'state', key);
    // Filtered on the content alone — a markdown window's text, a table's rows — since
    // the `{ renderer, content }` wrapper is what a line filter would otherwise match.
    if (hasLineFilter(readOptions)) {
      const text = applyReadOptionsToValue(win.content.data, uri, readOptions);
      return { content: [{ type: 'text', text }], readFiltered: true };
    }
    return okJsonResource(uri, {
      renderer: win.content.renderer,
      content: win.content.data,
    });
  }

  if (key === '__screenshot') {
    const askedAt = Date.now();
    const { imageData, captureFailure, captureError, captureDegraded, keyboard } =
      await captureWindow(windowState, win);
    if (!imageData) {
      // A capture is a round trip into the page, so "no image" can equally mean the
      // page was not running. Say which, where the desktop told us — and pass the
      // desktop's own sentence through: it is the only record of why, since the
      // feedback frame itself is not logged.
      const away = clientAwayNote(getActiveSessionId(), askedAt);
      return error(
        `Could not capture window "${windowId}"${captureFailure ? ` (${captureFailure})` : ''}.` +
          (captureError ? ` ${captureError}` : '') +
          (away ? ` ${away}` : ''),
      );
    }
    const image = { type: 'image' as const, ...(await captureForModel(imageData)) };
    // The caveats lead, because they change how the image below should be read.
    const caveats = [
      ...(captureDegraded ? [describeCaptureDegraded(captureDegraded)] : []),
      ...(keyboard ? [describeKeyboard(keyboard)] : []),
    ];
    return {
      content: [...caveats.map((text) => ({ type: 'text' as const, text })), image],
    };
  }

  return null;
}

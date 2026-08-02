/**
 * Clipboard business logic — the ceilings, and what each way of failing means.
 *
 * Two facts shape this module.
 *
 * **The clipboard is the browser's.** The server cannot read it; it asks the desktop and
 * waits (`ActionEmitter.readUserClipboard`). Every failure below is therefore a *browser*
 * failure with a browser-specific fix, and the caller is an LLM that will act on whatever
 * it is told — so "clipboard read failed" is not an acceptable answer. A denied read is
 * fixed by the user granting clipboard access; an unfocused one by clicking the desktop;
 * an empty one by copying something first. Each gets its own sentence.
 *
 * **What is on a clipboard is unbounded, and the reader has a context window.** A pasted
 * log can be megabytes; a screenshot from a 4K display is ~30 MB decoded. Neither belongs
 * in a conversation, and neither should be discovered *after* it has crossed the socket —
 * so `read` names its ceilings in the action itself and the desktop applies them before
 * sending (see `UserClipboardReadAction`).
 *
 * Truncating is a loss, though, and losing the user's data silently would be worse than
 * refusing to read it. So the two doors say different things:
 *
 *   - `read`  — the head of it, sized for a conversation, always naming the true length.
 *   - `save`  — the whole of it, to a file, sized for a disk. The URI comes back, not the
 *               bytes. This is the escape hatch for both "too long" and "too big to look
 *               at": a 30 MB screenshot becomes a `yaar://storage/...` an app can open.
 *
 * They are not two spellings of one door — `save` has an effect, `read` does not — which
 * is why the ceiling knob lives on `save` rather than as an option to `read` (see the
 * "describe is the manual, read is the current value" rule in packages/server/CLAUDE.md).
 */

import type { ClipboardImagePayload } from '@yaar/shared';
import { actionEmitter, type ClipboardFeedback } from '../../session/action-emitter.js';
import type { PendingOutcome } from '../../session/pending-store.js';
import { storageWrite } from '../../storage/storage-manager.js';

/**
 * How much clipboard text a `read` returns.
 *
 * ~20k characters is roughly 5k tokens — a long document's worth, and still a small
 * fraction of any context window. Past it the agent is told the true length and pointed
 * at `save`, which is nearly always what it wanted anyway: nothing useful is done with
 * the 400th kilobyte of a paste by reading it into a prompt.
 */
export const CLIPBOARD_TEXT_LIMIT = 20_000;

/** Longest edge a clipboard image is downscaled to for `read`. Plenty to *see* what it is. */
export const CLIPBOARD_IMAGE_MAX_PX = 1_600;

/** Ceiling on the image a `read` will carry. Past it, the read reports the size instead. */
export const CLIPBOARD_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Ceilings for `save`. Sized for a file rather than for a prompt — the bytes go to disk
 * and only the URI comes back — but still bounded: this payload crosses a WebSocket frame,
 * and an unbounded one is a way to take the desktop down rather than a feature.
 */
export const CLIPBOARD_SAVE_TEXT_LIMIT = 20_000_000;
export const CLIPBOARD_SAVE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/** What the caller gets back. Plain data — the handler turns it into a `VerbResult`. */
export interface ClipboardReadResult {
  success: boolean;
  text?: string;
  truncated?: boolean;
  totalChars?: number;
  image?: ClipboardImagePayload;
  error?: string;
}

/**
 * Why the desktop could not read the clipboard, said in a way that names the fix.
 *
 * The `reason` codes come from `classifyClipboardError` in the frontend; anything this
 * function does not recognize falls through to the desktop's own message, which is better
 * than a generic one and much better than a shrug.
 */
function explainFailure(feedback: ClipboardFeedback): string {
  switch (feedback.reason) {
    case 'denied':
      return (
        'The browser refused clipboard access. YAAR reads the clipboard through the page, ' +
        'so this is a browser permission, not a YAAR one: the user has to allow clipboard ' +
        'access for this site (the padlock/site-settings menu in the address bar) and then ' +
        'the read can be retried. Ask them for the content directly if they would rather not.'
      );
    case 'not-focused':
      return (
        'The browser would not read the clipboard because the YAAR tab is not focused. ' +
        'Ask the user to click on the desktop and try again — nothing is broken.'
      );
    case 'unsupported':
      return (
        'This browser exposes no clipboard read API to the page. Ask the user to paste the ' +
        'content instead (invoke yaar://user/prompts with action "request").'
      );
    case 'empty':
      return 'The clipboard is empty, or holds a format that cannot be read as text or an image.';
    case 'too-large':
      return `The clipboard holds an image too large to return${
        feedback.error ? ` (${feedback.error})` : ''
      }. Use invoke with action "save" to write it straight to storage instead.`;
    default:
      return feedback.error ?? 'The desktop could not read the clipboard.';
  }
}

/** Turn a settled (or unsettled) wait into either the desktop's answer or a reason it isn't. */
function unwrap(outcome: PendingOutcome<ClipboardFeedback>): ClipboardFeedback | { error: string } {
  if (outcome.ok) {
    return outcome.value.ok ? outcome.value : { error: explainFailure(outcome.value) };
  }
  // A deadline that passed is not a clipboard that was empty, and neither is a desktop that
  // went away mid-read. Both used to be the caller's problem to guess at.
  return {
    error:
      outcome.reason === 'timeout'
        ? 'The desktop did not answer the clipboard request in time. It may be showing the ' +
          'browser’s own clipboard-permission prompt, which nobody has answered yet.'
        : 'The desktop disconnected before it could read the clipboard.',
  };
}

function isFailure(v: ClipboardFeedback | { error: string }): v is { error: string } {
  return !('requestId' in v);
}

/**
 * Read the system clipboard for an agent — text truncated, image downscaled.
 */
export async function readClipboard(opts?: { image?: boolean }): Promise<ClipboardReadResult> {
  const answer = unwrap(
    await actionEmitter.readUserClipboard({
      maxChars: CLIPBOARD_TEXT_LIMIT,
      image: opts?.image ?? true,
      maxImagePx: CLIPBOARD_IMAGE_MAX_PX,
      maxImageBytes: CLIPBOARD_IMAGE_MAX_BYTES,
    }),
  );
  if (isFailure(answer)) return { success: false, error: answer.error };

  if (!answer.text && !answer.image) {
    return { success: false, error: 'The clipboard is empty.' };
  }

  return {
    success: true,
    text: answer.text,
    truncated: answer.truncated,
    totalChars: answer.totalChars,
    image: answer.image,
  };
}

/** Put text on the system clipboard. */
export async function writeClipboard(text: string): Promise<{ success: boolean; error?: string }> {
  const answer = unwrap(await actionEmitter.writeUserClipboard(text));
  if (isFailure(answer)) return { success: false, error: answer.error };
  return { success: true };
}

export interface ClipboardSaveResult {
  success: boolean;
  /** Where it landed, as the URI the agent can hand to a window, an app, or `read`. */
  uri?: string;
  bytes?: number;
  /** `text` or the image's mime type — what was actually on the clipboard. */
  kind?: string;
  /**
   * Even `save` has a ceiling, and a file that is quietly the first 20 MB of a 60 MB paste
   * is a file that will be read later as if it were whole.
   */
  truncated?: boolean;
  totalChars?: number;
  error?: string;
}

/** Extension a clipboard image should be stored under, from its mime type. */
function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0] ?? 'png';
  return subtype === 'jpeg' ? 'jpg' : subtype;
}

/**
 * Write the whole clipboard to storage and return its URI.
 *
 * Deliberately never returns the content: the entire point is that this is the door for
 * clipboard payloads too large to read into a conversation, and handing them back in the
 * tool result would spend exactly the context the truncation was protecting.
 *
 * `path` may omit an extension for images — the clipboard's own mime type decides it, so
 * an agent that has not read the clipboard yet does not have to guess whether it is
 * saving a PNG or a WebP.
 */
export async function saveClipboard(path: string): Promise<ClipboardSaveResult> {
  const answer = unwrap(
    await actionEmitter.readUserClipboard({
      maxChars: CLIPBOARD_SAVE_TEXT_LIMIT,
      image: true,
      maxImagePx: 0, // full resolution: this is going to a file, not into a prompt
      maxImageBytes: CLIPBOARD_SAVE_IMAGE_MAX_BYTES,
    }),
  );
  if (isFailure(answer)) return { success: false, error: answer.error };

  // An image wins over text when both are present: a screenshot pasted from a design tool
  // usually carries a text/plain alternative naming the file, and saving that name instead
  // of the picture would look like a successful save of the wrong thing.
  if (answer.image) {
    const filePath = /\.[a-z0-9]+$/i.test(path)
      ? path
      : `${path}.${extensionFor(answer.image.mimeType)}`;
    const written = await storageWrite(filePath, Buffer.from(answer.image.data, 'base64'));
    if (!written.success) return { success: false, error: written.error };
    return {
      success: true,
      uri: `yaar://storage/${filePath}`,
      bytes: answer.image.bytes,
      kind: answer.image.mimeType,
    };
  }

  if (!answer.text) return { success: false, error: 'The clipboard is empty.' };

  const written = await storageWrite(path, answer.text);
  if (!written.success) return { success: false, error: written.error };
  return {
    success: true,
    uri: `yaar://storage/${path}`,
    bytes: Buffer.byteLength(answer.text, 'utf8'),
    kind: 'text',
    truncated: answer.truncated,
    totalChars: answer.totalChars,
  };
}

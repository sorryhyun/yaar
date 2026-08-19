/**
 * Resolve a `yaar://storage/…` handed to a *text* renderer as its content.
 *
 * ── What this fixes ──
 *
 * `renderer: "iframe"` has always accepted a URI as its content — `yaar://apps/{id}`,
 * `yaar://storage/report.pdf` — and resolves it to something the browser can load. So
 * the natural next thing to write is
 *
 *   invoke('yaar://windows/', { action: 'create', title: 'Plan',
 *                               renderer: 'markdown', content: 'yaar://storage/plan.md' })
 *
 * and until this module that succeeded, reported success, and put a window on the
 * desktop displaying the eleven characters `yaar://stor…` as its body. No error, and
 * `read('yaar://windows/plan')` confirmed the *stored* content was the URI string: the
 * pointer was never resolved anywhere, it was simply markdown-formatted as literal text
 * (GitHub issue #87). One renderer's convention silently meant nothing in the others.
 *
 * ── Where it happens, and why here rather than in the renderer ──
 *
 * Server-side, at create/update, substituting the text into the action before it is
 * emitted. The window then *holds* what it displays, which is what makes the rest of the
 * system agree with the screen: `read` on the window returns the document, the reload
 * cache fingerprints the document, a session restore replays the document. Resolving in
 * the frontend renderer instead would fix the pixels and leave every one of those
 * reading back a URI.
 *
 * The consequence to know: this is a **snapshot**, taken once, at the moment of the
 * call. A later write to the file does not reach an open window — reissue the create,
 * or `update` it. A live view is what an app window is for.
 *
 * ── Who may ask for it ──
 *
 * Only a caller that could have read the file itself (`mayDelegateGrants`, the same
 * question `delegated-grants.ts` asks and for the same reason). `window.create` is
 * reachable over `POST /api/verb` by any app declaring `yaar://windows/`, so a server
 * that read files into windows on request would be handing every such app the whole
 * storage tree via a window it can then read back. An app gets the explicit refusal
 * below instead, which costs it one `read` it was always allowed to make.
 */

import { resolveResourceUri } from '../../handlers/uri-resolve.js';
import { isTextFile } from '../../storage/text-extensions.js';
import { mayDelegateGrants } from './delegated-grants.js';

/**
 * Renderers whose content is a string of text the server can fetch on the caller's
 * behalf. `iframe` resolves URIs by a different route (to a URL, not to bytes) and is
 * handled in `create.ts`; `table` and `component` take structured data, so a URI in
 * either is a type error rather than a pointer to follow.
 */
const TEXT_RENDERERS = new Set(['markdown', 'text', 'html']);

/**
 * Ceiling on an inlined document.
 *
 * Window content is broadcast to every connection in the session, re-broadcast on
 * reconnect, and kept in the frontend store — so this is a live-memory cost, not a
 * one-off transfer, and a 40MB log file named by accident should not become one.
 * Whoever wants a slice of something bigger can `read` it with a `lines` range.
 */
const MAX_INLINE_BYTES = 512 * 1024;

export type InlineResult = { ok: true; data: string } | { ok: false; message: string };

/** Does this create/update name a URI for a renderer that takes text? */
export function namesInlinableUri(renderer: string | undefined, data: unknown): data is string {
  return (
    !!renderer &&
    TEXT_RENDERERS.has(renderer) &&
    typeof data === 'string' &&
    data.startsWith('yaar://')
  );
}

/** Read the document a text renderer's content URI names, or say why it cannot be. */
export async function inlineUriContent(renderer: string, uri: string): Promise<InlineResult> {
  const resolved = resolveResourceUri(uri);
  if (!resolved || resolved.kind !== 'storage') {
    return {
      ok: false,
      message:
        `"content" for the "${renderer}" renderer names ${uri}, which is not a storage file. ` +
        `Only yaar://storage/… (and yaar://apps/{id}/storage/…) are read into a window; ` +
        `use renderer "iframe" to embed an app or a served document.`,
    };
  }

  if (!mayDelegateGrants()) {
    return {
      ok: false,
      message:
        `Refusing to read ${uri} into a window on your behalf — an app cannot have the ` +
        `server open a file for it. Read the file yourself and pass its text as "content".`,
    };
  }

  if (!isTextFile(resolved.absolutePath)) {
    return {
      ok: false,
      message:
        `${uri} is not a text file, so it cannot be rendered as "${renderer}". ` +
        `Use renderer "iframe" with the same URI to display it.`,
    };
  }

  const file = Bun.file(resolved.absolutePath);
  if (!(await file.exists())) {
    return { ok: false, message: `${uri} names no file. Nothing was created.` };
  }
  if (file.size > MAX_INLINE_BYTES) {
    return {
      ok: false,
      message:
        `${uri} is ${Math.round(file.size / 1024)} KB, over the ` +
        `${MAX_INLINE_BYTES / 1024} KB a window may hold. Read the part you want ` +
        `(a "lines" range) and pass that text as "content".`,
    };
  }

  try {
    return { ok: true, data: await file.text() };
  } catch (err) {
    return {
      ok: false,
      message: `Could not read ${uri}: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

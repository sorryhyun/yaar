// @ts-nocheck — This file runs in browser iframes, not the server (the compiler's
// tsconfig has no DOM lib, and a test imports this file directly).
/**
 * `@bundled/marked` — markdown, plus the one render every app was writing by hand.
 *
 * Seven apps wrapped `marked.parse` → `sanitizeHtml` with the same three concerns
 * (lab, storage, chitchats, dc-comics, slides-lite, github, and — differently —
 * word-excel). Each copy was correct; they differed only in options. The concerns:
 *
 * 1. **A parse failure must fall back to text, not to an empty box.** marked
 *    throws when a renderer throws (`silent` is off by default), and an app that
 *    catches it and returns `''` shows a blank message with no clue why. Here the
 *    source comes back as escaped paragraphs — readable, and obviously unrendered.
 * 2. **Links must not navigate the app frame.** An `<a>` left alone navigates the
 *    iframe itself, replacing the whole app with whatever a model or a README
 *    linked to; the only way back is a reload, and an app's live agents do not
 *    survive one. Every link therefore gets `target=_blank rel=noopener noreferrer`
 *    unless the caller opts out because it rewrites links itself (github).
 * 3. **Sanitize the whole fragment, then rewrite.** The order the authoring
 *    contract fixes (see `sanitizeHtml`'s header): the link pass runs over output
 *    DOMPurify has already cleaned, so it is about link behavior only, never about
 *    safety, and there is no second sanitize to keep in step with the first.
 *
 * Two rules the implementation keeps:
 *
 * - **A private `Marked` instance per call.** github's `marked.setOptions` and
 *   slides-lite's `marked.use` were per-app only because each app is its own
 *   bundle. A shim shared by every app cannot touch the global `marked` — a
 *   renderer one app registered would leak into another's render — so options
 *   and extensions apply to the instance built for this call and nothing else.
 * - **Nothing runs at module scope.** `protocol/fold-schemas.ts` evaluates an
 *   app's entry module in a Worker with a stubbed `document`; a shim that touched
 *   the DOM on import would fail that build for any app declaring a Zod schema.
 *
 * Lives here rather than in `@bundled/yaar` for the same reason `renderMermaid`
 * lives in `@bundled/mermaid`: the helper belongs with the library it wraps, so
 * an app that never renders markdown does not pull marked in through the SDK
 * barrel.
 *
 * The known non-consumer is word-excel's `markdownToHtml`: it is deliberately
 * unsanitized (its sanitize step sits at the block-insertion sites) and rewrites
 * page-break markers before parsing. Adopting this would move its security
 * boundary, so it keeps its own call and a lint suppression saying why.
 */

import { Marked, type MarkedExtension } from 'marked';
import { escapeHtml, sanitizeHtml } from './yaar/sanitize.js';

export * from 'marked';

export interface RenderMarkdownOptions {
  /** GFM line breaks — a single newline becomes `<br>`. For chat-like text. Default `false`. */
  breaks?: boolean;
  /**
   * Rewrite every `<a href>` to `target=_blank rel=noopener noreferrer`. Default
   * `true`: an `<a>` left alone navigates the app frame itself, and that is never
   * what an app wants. Pass `false` only when the app runs its own link rewrite
   * over the returned (already sanitized) fragment.
   */
  externalLinks?: boolean;
  /**
   * marked extensions applied to THIS render only — a custom `renderer.code` for
   * a diagram fence, say. Never registered on the global `marked`.
   */
  use?: MarkedExtension[];
}

/** The source as escaped paragraphs: readable, and obviously not rendered. */
function escapedParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * Markdown → HTML that is safe for `innerHTML`.
 *
 * Parse (GFM) → `sanitizeHtml` the whole fragment → rewrite links. Never throws:
 * a parse failure returns the source as escaped paragraphs rather than `''`.
 * Empty or whitespace-only input returns `''`.
 */
export function renderMarkdown(src: string, opts: RenderMarkdownOptions = {}): string {
  const text = src == null ? '' : String(src);
  if (!text.trim()) return '';

  let parsed: string;
  try {
    const md = new Marked(
      { gfm: true, breaks: opts.breaks ?? false, async: false },
      ...(opts.use ?? []),
    );
    const out = md.parse(text, { async: false });
    parsed = typeof out === 'string' ? out : escapedParagraphs(text);
  } catch {
    parsed = escapedParagraphs(text);
  }

  const clean = sanitizeHtml(parsed);

  // The DOM pass costs a parse of the fragment; skip it when there is no anchor
  // to rewrite, which is most chat lines and most cells.
  if (opts.externalLinks === false || !/<a[\s>]/i.test(clean)) return clean;

  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  for (const a of Array.from(tpl.content.querySelectorAll('a[href]'))) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  return tpl.innerHTML;
}

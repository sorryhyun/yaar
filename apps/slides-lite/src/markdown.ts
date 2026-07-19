export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

import { marked } from '@bundled/marked';
import DOMPurify from '@bundled/dompurify';

/** Shared no-forms deviation from DOMPurify's defaults. See the sanitize call below. */
const FORBID_FORM_TAGS = ['form', 'input', 'button', 'select', 'textarea', 'option'];

/**
 * Resolves a user-supplied URL, returning '' unless it is http(s).
 * Used for attribute sinks we build ourselves (e.g. slide.imageUrl), which never
 * pass through DOMPurify because they are not part of the untrusted markdown fragment.
 */
export function safeUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw, window.location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>`;
    },
  },
  gfm: true,
  breaks: true,
});

/**
 * The single sanitization choke point for untrusted slide content.
 *
 * Order matters and follows the app-library integration contract:
 *   1. parse markdown   2. sanitize the whole fragment   3. rewrite the SANITIZED
 *   fragment   4. hand back for insertion   5. behavior is attached by callers via
 *   addEventListener, never inline attributes.
 *
 * Every consumer of renderSlideHtml (canvas, present mode, PDF export) receives
 * already-clean body HTML, so no sink needs to sanitize again.
 */
export function renderBodyContent(raw: string): string {
  if (!raw || !raw.trim()) return '<p></p>';
  let parsed: string;
  try {
    parsed = (marked.parse(raw, { async: false }) as string) || '<p></p>';
  } catch {
    // fallback: display as plain text
    parsed = `<p>${escapeHtml(raw).replaceAll('\n', '<br/>')}</p>`;
  }

  // Baseline is DOMPurify.sanitize(dirty) with no options, matching the OS shell's
  // MarkdownRenderer. One deliberate deviation, shared by every YAAR app that renders
  // foreign HTML: <form> and its controls are on DOMPurify's default allowlist, but a
  // deck has no legitimate use for one, and a form embedded in shared deck content can
  // phish a viewer by POSTing their input to another origin. Forbidding the controls
  // too avoids leaving orphaned inputs behind when the wrapper is removed.
  const clean = DOMPurify.sanitize(parsed, { FORBID_TAGS: FORBID_FORM_TAGS });

  // App-specific rewrite, applied only after sanitization: slides open links in a
  // new tab. DOMPurify already dropped javascript:/data: hrefs, so this pass is
  // purely about link behavior, not safety.
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  for (const a of Array.from(tpl.content.querySelectorAll('a'))) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  return tpl.innerHTML || '<p></p>';
}

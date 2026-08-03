// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * The one HTML sanitizer every app that renders foreign markup should use.
 *
 * Four apps independently wrote this wrapper (dc-comics, github, recent-papers,
 * thesingularity-reader) plus storage and slides-lite, and all six converged on
 * the same deviation from DOMPurify's defaults, each explaining it in its own
 * comment. This is that deviation, written once.
 */

import DOMPurify from 'dompurify';

/**
 * `form` and its controls are on DOMPurify's default ALLOWED_TAGS. That is right
 * for a general-purpose sanitizer and wrong for an app iframe: no foreign content
 * YAAR renders has a legitimate reason to post, and a form inside the iframe can
 * navigate it or phish against the app's chrome. Nothing YAAR renders needs them,
 * so forbidding them costs no fidelity.
 *
 * DOMPurify lifts a forbidden tag's children rather than dropping them, and it
 * re-scans, so text inside a stripped `<form>` survives as plain content.
 */
const FORM_TAGS = ['form', 'input', 'button', 'select', 'textarea', 'option'];

export interface SanitizeHtmlOptions {
  /** Restrict to an explicit tag allowlist (DOMPurify `ALLOWED_TAGS`). */
  allowedTags?: string[];
  /** Restrict to an explicit attribute allowlist (DOMPurify `ALLOWED_ATTR`). */
  allowedAttr?: string[];
  /**
   * Extra tags to forbid. Added to the form-control default — except when
   * `allowedTags` is given, in which case the allowlist is the whole policy and
   * this list is the only subtraction from it.
   */
  forbidTags?: string[];
  /** Attributes to forbid (DOMPurify `FORBID_ATTR`). */
  forbidAttr?: string[];
}

/**
 * Sanitize untrusted HTML for insertion into an app iframe.
 *
 * The default policy is DOMPurify's own — which already strips scripts, event
 * handlers, and `javascript:`/`data:` URLs — plus the no-forms deviation above.
 * Deliberately *not* configured here, because each one broke an app that tried it:
 *
 * - No `USE_PROFILES`. It **overrides** `ALLOWED_TAGS` rather than intersecting
 *   with it, so setting both silently discards the allowlist.
 * - No narrowed `ALLOWED_URI_REGEXP`. DOMPurify applies that pattern to every
 *   attribute value it treats as a URI, so `/^https?:\/\//` also kills in-page
 *   `#anchor` hrefs and relative image paths.
 * - Relative URLs are left verbatim: DOMPurify neither strips nor absolutizes
 *   them. An app that needs them resolved must rewrite the *sanitized* output.
 *
 * The correct call order is always parse -> sanitize the whole fragment ->
 * rewrite -> insert. Rewriting before sanitizing hands the sanitizer a string
 * you have already modified; sanitizing fragments separately lets a tag opened
 * in one and closed in another slip through.
 */
export function sanitizeHtml(html: string, opts?: SanitizeHtmlOptions): string {
  const config: Record<string, unknown> = {};

  // The form-control default is a correction to DOMPurify's *default* allowlist, so it
  // applies only when that allowlist is in play. An explicit `allowedTags` already
  // confines the output to what it names, and layering a hidden subtraction under it
  // would silently drop a tag the caller deliberately allowed — invisible at the call
  // site, which is the exact failure mode the sanitizer traps are about. An allowlist
  // that wants a form control simply names it; one that doesn't, doesn't.
  const forbid = opts?.allowedTags
    ? (opts.forbidTags ?? [])
    : [...FORM_TAGS, ...(opts?.forbidTags ?? [])];
  if (forbid.length) config.FORBID_TAGS = forbid;

  if (opts?.allowedTags) config.ALLOWED_TAGS = opts.allowedTags;
  if (opts?.allowedAttr) config.ALLOWED_ATTR = opts.allowedAttr;
  if (opts?.forbidAttr) config.FORBID_ATTR = opts.forbidAttr;
  return DOMPurify.sanitize(html, config) as string;
}

/** The five characters that can end a text run and start markup. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape text for interpolation into HTML.
 *
 * The other half of the untrusted-content story: `sanitizeHtml` cleans markup an
 * app means to *render*, this neutralizes text an app means to *show* — a commit
 * message in a template literal, a filename in a tooltip.
 *
 * Six apps wrote it and three of them escaped only `& < >`, which is safe in a
 * text node and not in `title="${…}"`, where a lone `"` ends the attribute and
 * everything after it is markup. Whether a given call site is in an attribute is
 * exactly the fact that changes when someone edits the template, so this covers
 * both contexts and there is no cheaper variant to reach for.
 *
 * `&#39;` rather than `&apos;` — the numeric form is understood everywhere,
 * including by HTML4 parsers and anything treating the output as XML. Escaping
 * for an XML *document* is a different grammar (`&apos;` is the spelling there);
 * a DOCX or SVG serializer should keep its own.
 */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

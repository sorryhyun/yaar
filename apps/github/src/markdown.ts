import { marked } from '@bundled/marked';
import DOMPurify from '@bundled/dompurify';
import { state } from './store';

marked.setOptions({ gfm: true, breaks: false });

/**
 * The one deviation every YAAR app makes from DOMPurify's defaults.
 *
 * `form` and its controls are on the default ALLOWED_TAGS. That is right for a
 * general-purpose sanitizer and wrong for an app iframe: no foreign content YAAR
 * renders has a legitimate form in it, while a form styled as app chrome can
 * collect a password and POST it to another origin. Forbidding the controls too
 * (not just `form`) avoids leaving orphaned inputs behind when the wrapper goes.
 */
const FORBID_FORM_TAGS = ['form', 'input', 'button', 'select', 'textarea', 'option'];

/** Render GitHub markdown to HTML (synchronous, unsanitized). */
export function renderMarkdown(md: string | null | undefined): string {
  if (!md) return '';
  try {
    const out = marked.parse(md, { async: false }) as unknown as string;
    return typeof out === 'string' ? out : '';
  } catch {
    return escapeHtml(md);
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Decode a base64 (possibly newline-wrapped) string as UTF-8 text. */
export function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// -- Sanitize + rewrite -----------------------------------------------------

export interface MdContext {
  owner: string;
  name: string;
  branch: string;
  /** Directory the markdown lives in, so relative paths resolve. '' = repo root. */
  dir?: string;
}

/** Absolute URL, protocol-relative, anchor, or data/blob URI - leave untouched. */
function isAbsolute(url: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
}

/** Resolve `rel` against `dir`, collapsing . and .. segments. */
function joinPath(dir: string, rel: string): string {
  const base = dir ? dir.replace(/^\/+|\/+$/g, '') + '/' : '';
  const parts: string[] = [];
  for (const seg of (base + rel).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Sanitize rendered markdown and rewrite repo-relative URLs to absolute GitHub URLs.
 *
 * Ordering matters and is deliberate:
 *   1. DOMPurify sanitizes the complete fragment (the ONLY security boundary here).
 *   2. We reparse the now-trusted output and rewrite repo-relative URLs.
 *
 * Rewriting strictly AFTER sanitization is what lets us mint known-safe
 * github.com / raw.githubusercontent.com URLs without relaxing DOMPurify's
 * default policy. Do not add element/attribute denylists to the rewrite pass:
 * a second, weaker policy alongside DOMPurify's invites someone to loosen one
 * believing the other still covers it.
 *
 * Relative images (`docs/gui.png`) must point at raw.githubusercontent.com or they
 * 404 silently; relative links must point at the repo blob/tree view.
 */
export function sanitizeAndRewrite(rendered: string, ctx: MdContext): string {
  if (!rendered) return '';
  const { owner, name, branch } = ctx;
  const dir = ctx.dir || '';

  // DOMPurify's defaults, plus the shared no-forms deviation every YAAR app that
  // renders foreign HTML applies: `form` and its controls ARE in the default
  // ALLOWED_TAGS, GitHub itself strips forms from rendered markdown, and a form
  // in a README is a phishing surface rather than content. Verified under jsdom
  // against 8 adversarial fixtures (nested forms, `formaction="javascript:"`,
  // autofocus handlers): forbidden nodes and their controls are removed with no
  // attribute leaking through re-parenting.
  //
  // DOMPurify keeps relative URLs verbatim - it neither strips nor absolutizes
  // them - which is what the rewrite pass below depends on.
  const clean = DOMPurify.sanitize(rendered, { FORBID_TAGS: FORBID_FORM_TAGS });
  if (!clean) return '';

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
  } catch {
    return '';
  }
  const root = doc.body;
  if (!root) return '';

  const rawBase = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/`;
  const blobBase = `https://github.com/${owner}/${name}`;

  for (const el of Array.from(root.querySelectorAll('*'))) {
    // Every URL still present here already passed DOMPurify's protocol policy,
    // so `isAbsolute` only decides WHETHER to rewrite - never whether it's safe.

    // Images / media: relative -> raw.githubusercontent.com
    const src = el.getAttribute('src');
    if (src != null && !isAbsolute(src)) {
      el.setAttribute('src', rawBase + joinPath(dir, src));
    }

    // Links: relative -> github.com blob/tree; anchors left alone.
    const href = el.getAttribute('href');
    if (href != null) {
      if (!isAbsolute(href)) {
        // A trailing slash means a directory listing -> /tree/, otherwise /blob/.
        const kind = href.endsWith('/') ? 'tree' : 'blob';
        const path = joinPath(dir, href);
        el.setAttribute('href', `${blobBase}/${kind}/${branch}/${path}`);
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  return root.innerHTML;
}

/**
 * Render markdown from the active repo: parse, sanitize, and resolve relative
 * paths against the repo's default branch.
 */
export function renderRepoMarkdown(md: string | null | undefined, dir = ''): string {
  if (!md) return '';
  const branch = state.repoInfo?.default_branch || 'HEAD';
  return sanitizeAndRewrite(renderMarkdown(md), {
    owner: state.repo.owner,
    name: state.repo.name,
    branch,
    dir,
  });
}

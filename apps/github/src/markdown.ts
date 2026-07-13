import { marked } from '@bundled/marked';
import { state } from './store';

marked.setOptions({ gfm: true, breaks: false });

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

/** Elements that must never survive into the document. */
const FORBIDDEN = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM']);

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
 * Relative images (`docs/gui.png`) must point at raw.githubusercontent.com or they
 * 404 silently; relative links must point at the repo blob/tree view.
 */
export function sanitizeAndRewrite(rendered: string, ctx: MdContext): string {
  if (!rendered) return '';
  const { owner, name, branch } = ctx;
  const dir = ctx.dir || '';

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(`<body>${rendered}</body>`, 'text/html');
  } catch {
    return '';
  }
  const root = doc.body;
  if (!root) return '';

  const rawBase = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/`;
  const blobBase = `https://github.com/${owner}/${name}`;

  for (const el of Array.from(root.querySelectorAll('*'))) {
    // Drop dangerous elements outright.
    if (FORBIDDEN.has(el.tagName)) {
      el.remove();
      continue;
    }

    // Strip every inline event handler (onerror, onload, onclick, ...).
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }

    // Images / media: relative -> raw.githubusercontent.com
    const src = el.getAttribute('src');
    if (src != null) {
      if (!isAbsolute(src)) {
        el.setAttribute('src', rawBase + joinPath(dir, src));
      } else if (!/^https?:/i.test(src)) {
        el.removeAttribute('src');
      }
    }

    // Links: relative -> github.com blob/tree; anchors left alone.
    const href = el.getAttribute('href');
    if (href != null) {
      if (!isAbsolute(href)) {
        // A trailing slash means a directory listing -> /tree/, otherwise /blob/.
        const kind = href.endsWith('/') ? 'tree' : 'blob';
        const path = joinPath(dir, href);
        el.setAttribute('href', `${blobBase}/${kind}/${branch}/${path}`);
      } else if (!/^(https?:|mailto:|#)/i.test(href)) {
        // javascript: and friends.
        el.removeAttribute('href');
      }
      if (el.tagName === 'A' && el.hasAttribute('href')) {
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

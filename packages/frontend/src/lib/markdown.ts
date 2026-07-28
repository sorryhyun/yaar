import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { resolveAssetUrl } from '@/lib/api';

/** Escape a string for safe use inside an HTML attribute value. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a string for safe use as HTML text content. */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * State attribute on a mermaid placeholder: `pending` until hydrated, then
 * `ready` or `error`. `MarkdownRenderer` finds the blocks by this attribute and
 * `typography.module.css` styles each state.
 */
export const MERMAID_ATTR = 'data-yaar-mermaid';

/** Marks the node holding a hydrated diagram (or its error note), so a re-render can replace it. */
export const MERMAID_OUTPUT_ATTR = 'data-yaar-mermaid-out';

/** Records the theme+source a block was last drawn for, so unchanged diagrams are not re-rendered. */
export const MERMAID_KEY_ATTR = 'data-yaar-mermaid-key';

const marked = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  renderer: {
    image({ href, title, text }) {
      const url = resolveAssetUrl(href);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<img src="${escapeAttr(url)}" alt="${escapeAttr(text)}"${titleAttr} style="max-width:100%;border-radius:4px">`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(href)}"${titleAttr} target="_blank" rel="noopener">${text}</a>`;
    },
    code({ text, lang }) {
      // The info string may carry more than the language (```mermaid title=…).
      if ((lang ?? '').trim().split(/\s+/)[0] !== 'mermaid') return false; // marked's default renderer

      // The source rides as *text*, never as an attribute value. DOMPurify runs
      // with SAFE_FOR_XML on by default, which deletes any attribute whose value
      // contains `-->` — and `A --> B` is most of mermaid's syntax, so a
      // `data-source="…"` placeholder would arrive empty for exactly the
      // diagrams people write. As text it also degrades correctly: a block that
      // is never hydrated stays a readable code block.
      return `<div ${MERMAID_ATTR}="pending"><pre><code>${escapeText(text)}</code></pre></div>`;
    },
  },
});

/**
 * Markdown → HTML, **unsanitized**. Exported only so the renderer half can be
 * tested: DOMPurify does not work under happy-dom (it drops `div`/`pre`/`p` and
 * duplicates text nodes), so a test that ran the full pipeline could assert
 * nothing about either half. UI code must call `markdownToSafeHtml`.
 */
export function markdownToHtml(data: string): string {
  return marked.parse(data) as string;
}

/** Markdown → sanitized HTML, ready for `dangerouslySetInnerHTML`. */
export function markdownToSafeHtml(data: string): string {
  return DOMPurify.sanitize(markdownToHtml(data));
}

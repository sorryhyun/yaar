export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

import { marked } from '@bundled/marked';

marked.use({
  renderer: {
    link({ href, title, text }: { href: string; title?: string | null; text: string }) {
      let safeHref = '';
      try {
        const parsed = new URL(href || '', window.location.href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          safeHref = parsed.toString();
        }
      } catch { /* noop */ }
      if (!safeHref) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
    },
    code({ text, lang }: { text: string; lang?: string }) {
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>`;
    },
  },
  gfm: true,
  breaks: true,
});

export function renderBodyContent(raw: string): string {
  if (!raw || !raw.trim()) return '<p></p>';
  try {
    const result = marked.parse(raw, { async: false }) as string;
    return result || '<p></p>';
  } catch {
    // fallback: display as plain text
    return `<p>${escapeHtml(raw).replaceAll('\n', '<br/>')}</p>`;
  }
}

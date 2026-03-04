import DOMPurify from 'dompurify';
import { memo, useMemo } from 'react';
import { Marked } from 'marked';
import { resolveAssetUrl } from '@/lib/api';
import styles from '@/styles/base/typography.module.css';

interface MarkdownRendererProps {
  data: string;
}

/** Escape a string for safe use inside an HTML attribute value. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
  },
});

function MarkdownRenderer({ data }: MarkdownRendererProps) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(data) as string), [data]);
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />;
}

export const MemoizedMarkdownRenderer = memo(MarkdownRenderer);

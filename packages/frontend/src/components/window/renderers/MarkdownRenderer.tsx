import { memo, useMemo } from 'react';
import { Marked } from 'marked';
import { resolveAssetUrl } from '@/lib/api';
import styles from '@/styles/base/typography.module.css';

interface MarkdownRendererProps {
  data: string;
}

const marked = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  renderer: {
    image({ href, title, text }) {
      const url = resolveAssetUrl(href);
      const titleAttr = title ? ` title="${title}"` : '';
      return `<img src="${url}" alt="${text}"${titleAttr} style="max-width:100%;border-radius:4px">`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener">${text}</a>`;
    },
  },
});

function MarkdownRenderer({ data }: MarkdownRendererProps) {
  const html = useMemo(() => marked.parse(data) as string, [data]);
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />;
}

export const MemoizedMarkdownRenderer = memo(MarkdownRenderer);

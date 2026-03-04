/**
 * HtmlRenderer - Renders HTML content with DOMPurify sanitization.
 */
import DOMPurify from 'dompurify';
import { memo, useMemo } from 'react';
import styles from '@/styles/window/renderers.module.css';

interface HtmlRendererProps {
  data: string;
}

function HtmlRenderer({ data }: HtmlRendererProps) {
  const sanitized = useMemo(() => DOMPurify.sanitize(data), [data]);
  return <div className={styles.html} dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

export const MemoizedHtmlRenderer = memo(HtmlRenderer);

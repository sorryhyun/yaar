/**
 * HtmlRenderer - Renders HTML content with DOMPurify sanitization.
 */
import DOMPurify from 'dompurify';
import { memo, useMemo } from 'react';
import styles from '@/styles/window/renderers.module.css';
import { resolveAssetUrl } from '@/lib/api';

interface HtmlRendererProps {
  data: string;
}

/**
 * Point server-relative asset references at the server, with auth.
 *
 * The AI writes plain paths — `<img src="/api/storage/chart.png">`. In local mode
 * resolveAssetUrl is the identity and this changes nothing. In remote mode the
 * desktop's token lives in the URL fragment, which a browser never sends on a
 * subresource request, so a raw path arrives unauthenticated and is refused. The
 * other renderers (markdown, component, iframe) already resolve their URLs; this one
 * got away without it only because remote auth used to exempt anything ending in
 * `.png` — which is exactly the exemption that made the token bypassable.
 */
function resolveAssetUrls(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('[src], [href]')) {
    for (const attr of ['src', 'href'] as const) {
      const value = el.getAttribute(attr);
      if (value?.startsWith('/api/')) el.setAttribute(attr, resolveAssetUrl(value));
    }
  }
  return doc.body.innerHTML;
}

function HtmlRenderer({ data }: HtmlRendererProps) {
  const sanitized = useMemo(() => resolveAssetUrls(DOMPurify.sanitize(data)), [data]);
  return <div className={styles.html} dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

export const MemoizedHtmlRenderer = memo(HtmlRenderer);

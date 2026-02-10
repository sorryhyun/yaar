/**
 * HtmlRenderer - Renders trusted HTML content.
 *
 * WARNING: Only use for trusted content. This renders raw HTML.
 */
import { memo } from 'react'
import styles from '@/styles/windows/renderers.module.css'

interface HtmlRendererProps {
  data: string
}

function HtmlRenderer({ data }: HtmlRendererProps) {
  return (
    <div
      className={styles.html}
      dangerouslySetInnerHTML={{ __html: data }}
    />
  )
}

export const MemoizedHtmlRenderer = memo(HtmlRenderer)

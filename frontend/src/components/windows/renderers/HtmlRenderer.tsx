/**
 * HtmlRenderer - Renders trusted HTML content.
 *
 * WARNING: Only use for trusted content. This renders raw HTML.
 */
import styles from './renderers.module.css'

interface HtmlRendererProps {
  data: string
}

export function HtmlRenderer({ data }: HtmlRendererProps) {
  return (
    <div
      className={styles.html}
      dangerouslySetInnerHTML={{ __html: data }}
    />
  )
}

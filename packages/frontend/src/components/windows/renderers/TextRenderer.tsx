/**
 * TextRenderer - Simple plain text display.
 */
import styles from '@/styles/base/typography.module.css'

interface TextRendererProps {
  data: string
}

export function TextRenderer({ data }: TextRendererProps) {
  return (
    <pre className={styles.text}>{data}</pre>
  )
}

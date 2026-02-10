/**
 * TextRenderer - Simple plain text display.
 */
import { memo } from 'react'
import styles from '@/styles/base/typography.module.css'

interface TextRendererProps {
  data: string
}

function TextRenderer({ data }: TextRendererProps) {
  return (
    <pre className={styles.text}>{data}</pre>
  )
}

export const MemoizedTextRenderer = memo(TextRenderer)

/**
 * MarkdownRenderer - Renders markdown content.
 *
 * Note: For production, use a proper markdown library like
 * react-markdown or marked. This is a simplified version.
 */
import { useMemo } from 'react'
import styles from '@/styles/base/typography.module.css'

interface MarkdownRendererProps {
  data: string
}

export function MarkdownRenderer({ data }: MarkdownRendererProps) {
  // Simple markdown conversion (production should use proper library)
  const html = useMemo(() => {
    const result = data
      // Escape HTML
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Headers
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      // Bold
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // Inline code
      .replace(/`(.*?)`/g, '<code>$1</code>')
      // Line breaks
      .replace(/\n/g, '<br>')

    return result
  }, [data])

  return (
    <div
      className={styles.markdown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

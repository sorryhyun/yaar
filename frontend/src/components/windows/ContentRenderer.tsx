/**
 * ContentRenderer - Renders window content based on renderer type.
 */
import type { WindowContent } from '@/types/actions'
import { MarkdownRenderer } from './renderers/MarkdownRenderer'
import { TableRenderer } from './renderers/TableRenderer'
import { HtmlRenderer } from './renderers/HtmlRenderer'
import { TextRenderer } from './renderers/TextRenderer'

interface ContentRendererProps {
  content: WindowContent
}

export function ContentRenderer({ content }: ContentRendererProps) {
  switch (content.renderer) {
    case 'markdown':
      return <MarkdownRenderer data={content.data as string} />

    case 'table':
      return <TableRenderer data={content.data as { headers: string[]; rows: string[][] }} />

    case 'html':
      return <HtmlRenderer data={content.data as string} />

    case 'text':
    default:
      return <TextRenderer data={String(content.data ?? '')} />
  }
}

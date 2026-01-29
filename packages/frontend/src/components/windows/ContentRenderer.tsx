/**
 * ContentRenderer - Renders window content based on renderer type.
 */
import type { WindowContent } from '@/types/actions'
import { MarkdownRenderer } from './renderers/MarkdownRenderer'
import { TableRenderer } from './renderers/TableRenderer'
import { HtmlRenderer } from './renderers/HtmlRenderer'
import { TextRenderer } from './renderers/TextRenderer'
import { IframeRenderer } from './renderers/IframeRenderer'

interface ContentRendererProps {
  content: WindowContent
  windowId: string
  requestId?: string
  onRenderSuccess?: (requestId: string, windowId: string, renderer: string) => void
  onRenderError?: (requestId: string, windowId: string, renderer: string, error: string, url?: string) => void
}

export function ContentRenderer({ content, windowId, requestId, onRenderSuccess, onRenderError }: ContentRendererProps) {
  switch (content.renderer) {
    case 'markdown':
      return <MarkdownRenderer data={content.data as string} />

    case 'table':
      return <TableRenderer data={content.data as { headers: string[]; rows: string[][] }} />

    case 'html':
      return <HtmlRenderer data={content.data as string} />

    case 'iframe':
      return (
        <IframeRenderer
          data={content.data as string | { url: string; sandbox?: string }}
          requestId={requestId}
          onRenderSuccess={() => requestId && onRenderSuccess?.(requestId, windowId, 'iframe')}
          onRenderError={(error, url) => requestId && onRenderError?.(requestId, windowId, 'iframe', error, url)}
        />
      )

    case 'text':
    default:
      return <TextRenderer data={String(content.data ?? '')} />
  }
}

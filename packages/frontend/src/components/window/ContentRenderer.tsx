/**
 * ContentRenderer - Renders window content based on renderer type.
 */
import { memo, useCallback } from 'react';
import type { WindowContent } from '@/types';
import { useWindowCallbacks } from '@/contexts/WindowCallbackContext';
import { MemoizedMarkdownRenderer } from './renderers/MarkdownRenderer';
import { MemoizedTableRenderer } from './renderers/TableRenderer';
import { MemoizedHtmlRenderer } from './renderers/HtmlRenderer';
import { MemoizedTextRenderer } from './renderers/TextRenderer';
import { MemoizedIframeRenderer } from './renderers/IframeRenderer';
import { ComponentRenderer } from './renderers/ComponentRenderer';

interface ContentRendererProps {
  content: WindowContent;
  windowId: string;
  requestId?: string;
}

function ContentRenderer({ content, windowId, requestId }: ContentRendererProps) {
  const callbacks = useWindowCallbacks();

  const handleIframeSuccess = useCallback(() => {
    if (requestId) callbacks?.onRenderSuccess(requestId, windowId, 'iframe');
  }, [requestId, windowId, callbacks]);

  const handleIframeError = useCallback(
    (error: string, url: string) => {
      if (requestId) callbacks?.onRenderError(requestId, windowId, 'iframe', error, url);
    },
    [requestId, windowId, callbacks],
  );

  switch (content.renderer) {
    case 'markdown':
      return <MemoizedMarkdownRenderer data={content.data as string} />;

    case 'table':
      return (
        <MemoizedTableRenderer data={content.data as { headers: string[]; rows: string[][] }} />
      );

    case 'html':
      return <MemoizedHtmlRenderer data={content.data as string} />;

    case 'iframe':
      return (
        <MemoizedIframeRenderer
          data={content.data as string | { url: string; sandbox?: string }}
          requestId={requestId}
          onRenderSuccess={handleIframeSuccess}
          onRenderError={handleIframeError}
        />
      );

    case 'component':
      return <ComponentRenderer data={content.data} windowId={windowId} />;

    case 'text':
    default:
      return <MemoizedTextRenderer data={String(content.data ?? '')} />;
  }
}

export const MemoizedContentRenderer = memo(ContentRenderer);

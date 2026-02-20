/**
 * ContentRenderer - Renders window content based on renderer type.
 */
import { memo, useCallback } from 'react';
import type { WindowContent } from '@/types';
import { MemoizedMarkdownRenderer } from './renderers/MarkdownRenderer';
import { MemoizedTableRenderer } from './renderers/TableRenderer';
import { MemoizedHtmlRenderer } from './renderers/HtmlRenderer';
import { MemoizedTextRenderer } from './renderers/TextRenderer';
import { MemoizedIframeRenderer } from './renderers/IframeRenderer';
import { ComponentRenderer } from './renderers/ComponentRenderer';

type FormValue = string | number | boolean;

interface ContentRendererProps {
  content: WindowContent;
  windowId: string;
  requestId?: string;
  onRenderSuccess?: (requestId: string, windowId: string, renderer: string) => void;
  onRenderError?: (
    requestId: string,
    windowId: string,
    renderer: string,
    error: string,
    url?: string,
  ) => void;
  onComponentAction?: (
    action: string,
    parallel?: boolean,
    formData?: Record<string, FormValue>,
    formId?: string,
    componentPath?: string[],
  ) => void;
}

function ContentRenderer({
  content,
  windowId,
  requestId,
  onRenderSuccess,
  onRenderError,
  onComponentAction,
}: ContentRendererProps) {
  const handleIframeSuccess = useCallback(() => {
    if (requestId) onRenderSuccess?.(requestId, windowId, 'iframe');
  }, [requestId, windowId, onRenderSuccess]);

  const handleIframeError = useCallback(
    (error: string, url: string) => {
      if (requestId) onRenderError?.(requestId, windowId, 'iframe', error, url);
    },
    [requestId, windowId, onRenderError],
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
      return (
        <ComponentRenderer data={content.data} windowId={windowId} onAction={onComponentAction} />
      );

    case 'text':
    default:
      return <MemoizedTextRenderer data={String(content.data ?? '')} />;
  }
}

export const MemoizedContentRenderer = memo(ContentRenderer);

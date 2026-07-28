import { memo, useEffect, useMemo, useRef } from 'react';
import {
  markdownToSafeHtml,
  MERMAID_ATTR,
  MERMAID_KEY_ATTR,
  MERMAID_OUTPUT_ATTR,
} from '@/lib/markdown';
import { renderMermaidCached } from '@/lib/mermaid';
import { useDesktopStore } from '@/store/desktop';
import styles from '@/styles/base/typography.module.css';

interface MarkdownRendererProps {
  data: string;
}

/**
 * Draws every ```mermaid block the sanitized HTML left behind.
 *
 * Two-phase on purpose: `markdownToSafeHtml` is synchronous and mermaid is not,
 * so the fence first becomes a plain code block (readable on its own) and is
 * swapped for an SVG once it renders. The `pre` holding the source is kept —
 * hidden by CSS in the `ready` state — so a theme change can redraw from it, and
 * so a failed diagram falls back to showing what the model actually wrote.
 */
function useMermaidHydration(html: string, container: React.RefObject<HTMLDivElement | null>) {
  // The palette DesktopSurface writes onto `:root`. Part of the cache key rather
  // than read back from the DOM, because a child's effect runs before its
  // parent's — at this point `:root` may still carry the previous theme.
  const theme = useDesktopStore((s) => s.theme);
  const accentColor = useDesktopStore((s) => s.accentColor);

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    const blocks = root.querySelectorAll<HTMLElement>(`[${MERMAID_ATTR}]`);
    // No diagram in this window: never touch the 3.3 MB chunk.
    if (blocks.length === 0) return;

    let cancelled = false;

    void (async () => {
      for (const block of blocks) {
        const source = block.querySelector('code')?.textContent ?? '';
        const key = `${theme}:${accentColor}:${source}`;
        // Already drawn for this palette and this source.
        if (block.getAttribute(MERMAID_KEY_ATTR) === key) continue;

        let output: HTMLElement;
        let state: 'ready' | 'error';
        try {
          const svg = await renderMermaidCached(key, source);
          if (cancelled || !block.isConnected) return;
          output = document.createElement('div');
          // Mermaid ran in `strict` mode, so this is already sanitized; a second
          // DOMPurify pass would strip the `<style>` block it themes itself with.
          output.innerHTML = svg;
          state = 'ready';
        } catch (err) {
          if (cancelled || !block.isConnected) return;
          output = document.createElement('div');
          // textContent, not innerHTML — a mermaid parse error quotes the source
          // back at you, and that source is model-authored.
          output.textContent = err instanceof Error ? err.message : String(err);
          state = 'error';
        }

        output.setAttribute(MERMAID_OUTPUT_ATTR, '');
        block.querySelectorAll(`[${MERMAID_OUTPUT_ATTR}]`).forEach((n) => n.remove());
        block.appendChild(output);
        block.setAttribute(MERMAID_ATTR, state);
        block.setAttribute(MERMAID_KEY_ATTR, key);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [html, theme, accentColor, container]);
}

function MarkdownRenderer({ data }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => markdownToSafeHtml(data), [data]);
  useMermaidHydration(html, containerRef);

  return (
    <div
      ref={containerRef}
      className={styles.markdown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const MemoizedMarkdownRenderer = memo(MarkdownRenderer);

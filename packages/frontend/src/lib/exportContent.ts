/**
 * Export window content as downloadable files.
 */
import { tryIframeSelfCapture } from '@/store/desktop';
import type { WindowModel } from '@/types/state';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[/\\?%*:|"<>]/g, '-');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function exportContent(
  content: WindowModel['content'],
  title: string,
  windowId?: string,
) {
  const { renderer, data } = content;
  let blob: Blob;
  let filename: string;

  switch (renderer) {
    case 'markdown':
    case 'text':
      blob = new Blob([String(data)], { type: 'text/plain' });
      filename = `${title}.${renderer === 'markdown' ? 'md' : 'txt'}`;
      break;
    case 'html':
      blob = new Blob([String(data)], { type: 'text/html' });
      filename = `${title}.html`;
      break;
    case 'table': {
      const tableData = data as { headers?: string[]; rows?: unknown[][] };
      if (tableData.headers && tableData.rows) {
        const csv = [
          tableData.headers.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(','),
          ...tableData.rows.map((row) =>
            row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
          ),
        ].join('\n');
        blob = new Blob([csv], { type: 'text/csv' });
        filename = `${title}.csv`;
      } else {
        blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        filename = `${title}.json`;
      }
      break;
    }
    case 'iframe': {
      // Three-tier iframe export: same-origin HTML > screenshot > URL fallback
      if (windowId) {
        const el = document.querySelector(
          `[data-window-id="${windowId}"] iframe`,
        ) as HTMLIFrameElement | null;
        if (el) {
          // Tier 1: Same-origin HTML export
          try {
            const doc = el.contentDocument;
            if (doc) {
              const html = doc.documentElement.outerHTML;
              triggerDownload(new Blob([html], { type: 'text/html' }), `${title}.html`);
              return;
            }
          } catch {
            /* cross-origin — fall through */
          }

          // Tier 2: Screenshot via self-capture protocol
          if (el.contentWindow) {
            const imageData = await tryIframeSelfCapture(el);
            if (imageData) {
              const res = await fetch(imageData);
              const pngBlob = await res.blob();
              triggerDownload(pngBlob, `${title}.png`);
              return;
            }
          }
        }
      }

      // Tier 3: URL fallback
      const iframeData = data as { url?: string } | string;
      const url = typeof iframeData === 'string' ? iframeData : iframeData?.url;
      blob = new Blob([url || ''], { type: 'text/plain' });
      filename = `${title}-url.txt`;
      break;
    }
    default:
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      filename = `${title}.json`;
  }

  triggerDownload(blob, filename);
}

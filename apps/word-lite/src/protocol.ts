import { app, storage, windows } from '@bundled/yaar';
import { countTextStats, nowLabel } from './utils';
import { editorEl, docTitleEl, saveStateText, setSaveStateText } from './state';
import { refreshStats } from './editor';
import {
  saveDoc,
  getTitle,
  setEditorFromPlainText,
  setEditorFromHtml,
  appendHtmlFragment,
  extractBodyHtml,
  docsToMergedHtml,
  BatchDocInput,
} from './documents';

type StorageReadAs = 'text' | 'json' | 'auto' | 'blob' | 'arraybuffer';

export function registerAppProtocol() {
  if (!app) return;

  app.register({
    appId: 'word-lite',
    name: 'Word Lite',
    state: {
      html: {
        description: 'Current document HTML content',
        handler: () => editorEl.innerHTML,
      },
      text: {
        description: 'Current document plain text content',
        handler: () => editorEl.innerText || '',
      },
      stats: {
        description: 'Current text stats as { words, chars }',
        handler: () => countTextStats(editorEl.innerText || ''),
      },
      title: {
        description: 'Current document title',
        handler: () => getTitle(),
      },
      saveState: {
        description: 'Current save status label',
        handler: () => saveStateText(),
      },
    },
    commands: {
      setContent: {
        description: 'Replace document content. Params: { content: string, renderer?: "html"|"text" }',
        params: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            renderer: { type: 'string', enum: ['html', 'text'] },
          },
          required: ['content'],
        },
        handler: (p: Record<string, unknown>) => {
          if (((p.renderer as string) ?? 'html') === 'text') {
            setEditorFromPlainText((p.content as string) || '');
          } else {
            setEditorFromHtml((p.content as string) || '<p></p>');
          }
          setSaveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      setTitle: {
        description: 'Update document title. Params: { title: string }',
        params: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
        handler: (p: Record<string, unknown>) => {
          docTitleEl.value = ((p.title as string) || '').trim() || 'Untitled Document';
          setSaveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      appendContent: {
        description: 'Append content to the end of the document. Params: { content: string, renderer?: "html"|"text" }',
        params: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            renderer: { type: 'string', enum: ['html', 'text'] },
          },
          required: ['content'],
        },
        handler: (p: Record<string, unknown>) => {
          if (((p.renderer as string) ?? 'html') === 'text') {
            const escaped = ((p.content as string) || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>');
            const para = document.createElement('p');
            para.innerHTML = escaped;
            editorEl.appendChild(para);
            refreshStats();
          } else {
            appendHtmlFragment((p.content as string) || '');
          }
          setSaveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      setDocuments: {
        description: 'Replace the editor with multiple documents at once. Params: { docs: Array<{ title?: string, text?: string, html?: string }> }',
        params: {
          type: 'object',
          properties: {
            docs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  text: { type: 'string' },
                  html: { type: 'string' },
                },
              },
            },
          },
          required: ['docs'],
        },
        handler: (p: Record<string, unknown>) => {
          const docs = Array.isArray(p.docs) ? (p.docs as BatchDocInput[]) : [];
          setEditorFromHtml(docsToMergedHtml(docs));
          setSaveStateText(`Loaded ${docs.length} document(s) via app protocol`);
          saveDoc();
          return { ok: true, count: docs.length };
        },
      },
      appendDocuments: {
        description: 'Append multiple documents to the current editor. Params: { docs: Array<{ title?: string, text?: string, html?: string }> }',
        params: {
          type: 'object',
          properties: {
            docs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  text: { type: 'string' },
                  html: { type: 'string' },
                },
              },
            },
          },
          required: ['docs'],
        },
        handler: (p: Record<string, unknown>) => {
          const docs = Array.isArray(p.docs) ? (p.docs as BatchDocInput[]) : [];
          appendHtmlFragment(docsToMergedHtml(docs));
          setSaveStateText(`Appended ${docs.length} document(s) via app protocol`);
          saveDoc();
          return { ok: true, count: docs.length };
        },
      },
      saveToStorage: {
        description: 'Save the current document to YAAR persistent storage. Params: { path: string } — e.g. "docs/my-doc.html"',
        params: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (p: Record<string, unknown>) => {
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const title = getTitle();
          const htmlContent = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${editorEl.innerHTML}</body></html>`;
          await storage.save(p.path as string, htmlContent);
          setSaveStateText(`Saved to storage: ${p.path}`);
          return { ok: true, path: p.path, savedAt: nowLabel() };
        },
      },
      loadFromStorage: {
        description: 'Load one or many documents from YAAR storage. Params: { path?: string, paths?: string[], mode?: "replace"|"append" }',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['replace', 'append'] },
          },
        },
        handler: async (p: Record<string, unknown>) => {
          if (!storage) return { ok: false, error: 'Storage API not available' };

          const candidatePaths = [
            ...(p.path ? [p.path as string] : []),
            ...(Array.isArray(p.paths) ? (p.paths as string[]) : []),
          ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

          if (!candidatePaths.length) {
            return { ok: false, error: 'Provide path or paths' };
          }

          const loadedDocs: BatchDocInput[] = [];
          for (const path of candidatePaths) {
            const raw = await storage.read(path, { as: 'text' as StorageReadAs }) as unknown as string;
            const body = extractBodyHtml(raw);
            const filename = path.split('/').pop() || path;
            const title = filename.replace(/\.[^/.]+$/, '') || 'Untitled Document';
            loadedDocs.push({ title, html: body });
          }

          const mode = (p.mode as string) || 'replace';
          const merged = docsToMergedHtml(loadedDocs);
          if (mode === 'append') {
            appendHtmlFragment(merged);
          } else {
            setEditorFromHtml(merged);
          }

          setSaveStateText(`Loaded ${loadedDocs.length} file(s) from storage`);
          saveDoc();
          return { ok: true, count: loadedDocs.length, paths: candidatePaths, mode };
        },
      },
      readStorageFile: {
        description: 'Read one file from YAAR storage without mutating the editor. Params: { path: string, as?: "text"|"json"|"auto" }',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            as: { type: 'string', enum: ['text', 'json', 'auto'] },
          },
          required: ['path'],
        },
        handler: async (p: Record<string, unknown>) => {
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const readAs = ((p.as as string) || 'text') as StorageReadAs;
          const content = await storage.read(p.path as string, { as: readAs });
          return { ok: true, path: p.path, as: readAs, content };
        },
      },
      readStorageFiles: {
        description: 'Read multiple files from YAAR storage without mutating the editor. Params: { paths: string[], as?: "text"|"json"|"auto" }',
        params: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' } },
            as: { type: 'string', enum: ['text', 'json', 'auto'] },
          },
          required: ['paths'],
        },
        handler: async (p: Record<string, unknown>) => {
          if (!storage) return { ok: false, error: 'Storage API not available' };

          const paths = (Array.isArray(p.paths) ? (p.paths as string[]) : []).filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          );
          const readAs = ((p.as as string) || 'text') as StorageReadAs;

          const files = await Promise.all(
            paths.map(async (path) => ({
              path,
              content: await storage!.read(path, { as: readAs }),
            })),
          );

          return { ok: true, as: readAs, files };
        },
      },
      newDocument: {
        description: 'Clear current document to a blank paragraph. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          editorEl.innerHTML = '<p></p>';
          docTitleEl.value = 'Untitled Document';
          refreshStats();
          setSaveStateText('Unsaved new document');
          return { ok: true };
        },
      },
      saveDraft: {
        description: 'Save current document to local draft storage. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          saveDoc();
          return { ok: true, savedAt: nowLabel() };
        },
      },
      importFromWindow: {
        description: 'Import content from another open window into this document. Params: { windowId: string, mode?: "replace"|"append", includeImage?: boolean }',
        params: {
          type: 'object',
          properties: {
            windowId: { type: 'string' },
            mode: { type: 'string', enum: ['replace', 'append'] },
            includeImage: { type: 'boolean' },
          },
          required: ['windowId'],
        },
        handler: async (p: Record<string, unknown>) => {
          if (!windows) return { ok: false, error: 'yaar.windows API not available' };

          const result = await (windows as any).read(p.windowId as string, { includeImage: (p.includeImage as boolean) ?? false });
          if (!result) return { ok: false, error: `Window "${p.windowId}" not found or returned no data` };

          const mode = (p.mode as string) ?? 'append';
          let html = '';

          // Build HTML from window content
          if (result.content) {
            const escaped = String(result.content)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>');
            html += `<p>${escaped}</p>`;
          }

          // Embed screenshot image if requested and available
          if (p.includeImage && result.image) {
            html += `<p><img src="${result.image}" alt="Window screenshot: ${p.windowId}" style="max-width:100%;border:1px solid #ddd;border-radius:4px;"></p>`;
          }

          if (!html) return { ok: false, error: 'No content to import from window' };

          if (mode === 'replace') {
            setEditorFromHtml(html);
          } else {
            appendHtmlFragment(html);
          }

          setSaveStateText(`Imported from window: ${p.windowId}`);
          saveDoc();
          return { ok: true, windowId: p.windowId, mode, hasImage: !!(p.includeImage && result.image) };
        },
      },
    },
  });
}

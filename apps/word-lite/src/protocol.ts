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

export function registerAppProtocol() {
  const appApi = (window as any).yaar?.app;
  if (!appApi) return;

  appApi.register({
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
      setHtml: {
        description: 'Replace document with HTML. Params: { html: string }',
        params: {
          type: 'object',
          properties: { html: { type: 'string' } },
          required: ['html'],
        },
        handler: (p: { html: string }) => {
          setEditorFromHtml(p.html || '<p></p>');
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
        handler: (p: { title: string }) => {
          docTitleEl.value = (p.title || '').trim() || 'Untitled Document';
          setSaveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      setText: {
        description: 'Replace document with plain text. Params: { text: string }',
        params: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        handler: (p: { text: string }) => {
          setEditorFromPlainText(p.text || '');
          setSaveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      appendText: {
        description: 'Append plain text as a new paragraph to the document. Params: { text: string }',
        params: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        handler: (p: { text: string }) => {
          const escaped = (p.text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          const para = document.createElement('p');
          para.innerHTML = escaped;
          editorEl.appendChild(para);
          refreshStats();
          setSaveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      appendHtml: {
        description: 'Append HTML content to the end of the document without replacing existing content. Params: { html: string }',
        params: {
          type: 'object',
          properties: { html: { type: 'string' } },
          required: ['html'],
        },
        handler: (p: { html: string }) => {
          appendHtmlFragment(p.html || '');
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
        handler: (p: { docs: BatchDocInput[] }) => {
          const docs = Array.isArray(p.docs) ? p.docs : [];
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
        handler: (p: { docs: BatchDocInput[] }) => {
          const docs = Array.isArray(p.docs) ? p.docs : [];
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
        handler: async (p: { path: string }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const title = getTitle();
          const htmlContent = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${editorEl.innerHTML}</body></html>`;
          await storage.save(p.path, htmlContent);
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
        handler: async (p: { path?: string; paths?: string[]; mode?: 'replace' | 'append' }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };

          const candidatePaths = [
            ...(p.path ? [p.path] : []),
            ...(Array.isArray(p.paths) ? p.paths : []),
          ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

          if (!candidatePaths.length) {
            return { ok: false, error: 'Provide path or paths' };
          }

          const loadedDocs: BatchDocInput[] = [];
          for (const path of candidatePaths) {
            const raw: string = await storage.read(path, { as: 'text' });
            const body = extractBodyHtml(raw);
            const filename = path.split('/').pop() || path;
            const title = filename.replace(/\.[^/.]+$/, '') || 'Untitled Document';
            loadedDocs.push({ title, html: body });
          }

          const mode = p.mode || 'replace';
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
        handler: async (p: { path: string; as?: 'text' | 'json' | 'auto' }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const readAs = p.as || 'text';
          const content = await storage.read(p.path, { as: readAs });
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
        handler: async (p: { paths: string[]; as?: 'text' | 'json' | 'auto' }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };

          const paths = (Array.isArray(p.paths) ? p.paths : []).filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          );
          const readAs = p.as || 'text';

          const files = await Promise.all(
            paths.map(async (path) => ({
              path,
              content: await storage.read(path, { as: readAs }),
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
    },
  });
}

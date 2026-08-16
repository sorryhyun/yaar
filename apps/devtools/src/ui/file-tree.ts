export {};
import { createSignal, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { files, openFilePath, activeProject, type FileEntry } from '../core';
import { openFile } from '../services';
import { setMainView } from './panel-state';

function getFileIcon(path: string): string {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return '📄';
  if (path.endsWith('.css')) return '🎨';
  if (path.endsWith('.json')) return '📋';
  if (path.endsWith('.md')) return '📝';
  return '📄';
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function parentDir(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

export function FileTree() {
  const [collapsedDirs, setCollapsedDirs] = createSignal<Set<string>>(new Set());

  function toggleDir(dirPath: string) {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }

  const orderedEntries = () => {
    const all = files();
    const collapsed = collapsedDirs();

    const byParent = new Map<string, FileEntry[]>();
    for (const entry of all) {
      const parent = parentDir(entry.path);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent)!.push(entry);
    }

    for (const children of byParent.values()) {
      children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
    }

    const result: FileEntry[] = [];

    function visit(parentPath: string) {
      const children = byParent.get(parentPath);
      if (!children) return;
      for (const entry of children) {
        result.push(entry);
        if (entry.isDirectory && !collapsed.has(entry.path)) {
          visit(entry.path);
        }
      }
    }

    visit('');
    return result;
  };

  return html`
    <div
      class="file-tree y-scroll"
      onClick=${(e: MouseEvent) => {
        const el = (e.target as HTMLElement).closest('[data-path]') as HTMLElement | null;
        if (!el) return;
        const path = el.dataset.path!;
        const isDir = el.dataset.isdir === 'true';
        if (isDir) {
          toggleDir(path);
        } else {
          // Opening a file has to reclaim the main pane from the diff view; the
          // editor is only one of the two things that can be showing there.
          setMainView('editor');
          openFile(path);
        }
      }}
    >
      <${Show} when=${() => !activeProject()}>
        <div class="file-tree-empty y-text-sm y-text-muted">No project open</div>
      </>
      <${Show} when=${() => activeProject()}>
        <${For} each=${orderedEntries}>
          ${(entry: FileEntry) => {
            const name = basename(entry.path);
            const depth = entry.path.split('/').length - 1;
            const indent = depth * 14;
            const isDir = entry.isDirectory;
            return html`
              <div
                data-path=${entry.path}
                data-isdir=${isDir ? 'true' : 'false'}
                class=${() =>
                  `file-tree-item${openFilePath() === entry.path ? ' active' : ''}${isDir ? ' dir' : ''}`}
                style=${`padding-left: ${8 + indent}px`}
              >
                <span class="file-icon">
                  ${() =>
                    isDir ? (collapsedDirs().has(entry.path) ? '▶' : '▼') : getFileIcon(entry.path)}
                </span>
                <span class="file-name">${name}</span>
              </div>
            `;
          }}
        </>
      </>
    </div>
  `;
}

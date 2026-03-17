export {};
import { createSignal, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { files, openFilePath, openFile, activeProject } from './project';
import type { FileEntry } from './project';

function getIcon(path: string, isDir: boolean, collapsed: boolean): string {
  if (isDir) return collapsed ? '📁' : '📂';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return '📄';
  if (path.endsWith('.css')) return '🎨';
  if (path.endsWith('.json')) return '📋';
  if (path.endsWith('.md')) return '📝';
  return '📄';
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

// Returns the direct parent directory of a path (empty string for root-level)
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

  function isVisible(entry: FileEntry): boolean {
    if (!entry.isDirectory && entry.path.includes('/')) {
      // Check if any ancestor directory is collapsed
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const ancestorPath = parts.slice(0, i).join('/');
        if (collapsedDirs().has(ancestorPath)) return false;
      }
    }
    if (entry.isDirectory && entry.path.includes('/')) {
      // Check if any ancestor directory is collapsed
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const ancestorPath = parts.slice(0, i).join('/');
        if (collapsedDirs().has(ancestorPath)) return false;
      }
    }
    return true;
  }

  const sortedFiles = () => {
    const all = files();
    // Show directories first, then files, alphabetically
    return [...all]
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.path.localeCompare(b.path);
      })
      .filter(isVisible);
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
          openFile(path);
        }
      }}
    >
      <${Show} when=${() => !activeProject()}>
        <div class="file-tree-empty y-text-sm y-text-muted">No project open</div>
      </>
      <${Show} when=${() => activeProject()}>
        <${For} each=${sortedFiles}>
          ${(entry: FileEntry) => {
            const name = basename(entry.path);
            const depthParts = entry.path.split('/');
            const indent = (depthParts.length - 1) * 12;
            return html`
              <div
                data-path=${entry.path}
                data-isdir=${entry.isDirectory ? 'true' : 'false'}
                class=${() =>
                  `file-tree-item${openFilePath() === entry.path ? ' active' : ''}${entry.isDirectory ? ' dir' : ''}`}
                style=${`padding-left: ${8 + indent}px`}
              >
                <span class="file-icon">${() => getIcon(entry.path, entry.isDirectory, collapsedDirs().has(entry.path))}</span>
                <span class="file-name">${name}</span>
              </div>
            `;
          }}
        </>
      </>
    </div>
  `;
}

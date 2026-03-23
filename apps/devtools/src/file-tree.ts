export {};
import { createSignal, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { files, openFilePath, openFile, activeProject } from './project';
import type { FileEntry } from './project';

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

  /**
   * DFS traversal: groups entries by parent, sorts each level
   * (directories first, then files, alphabetically), and visits
   * children only when the parent directory is not collapsed.
   */
  const orderedEntries = () => {
    const all = files();
    const collapsed = collapsedDirs();

    // Group by immediate parent directory
    const byParent = new Map<string, FileEntry[]>();
    for (const entry of all) {
      const parent = parentDir(entry.path);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent)!.push(entry);
    }

    // Sort each group: dirs before files, then alphabetically
    for (const children of byParent.values()) {
      children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
    }

    // DFS: root entries first, then recurse into open directories
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
                  ${() => isDir
                    ? (collapsedDirs().has(entry.path) ? '▶' : '▼')
                    : getFileIcon(entry.path)}
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

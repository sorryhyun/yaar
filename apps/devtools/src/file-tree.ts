export {};
import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { files, openFilePath, openFile, activeProject } from './project';
import type { FileEntry } from './project';

function getIcon(path: string, isDir: boolean): string {
  if (isDir) return '📁';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return '📄';
  if (path.endsWith('.css')) return '🎨';
  if (path.endsWith('.json')) return '📋';
  if (path.endsWith('.md')) return '📝';
  return '📄';
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export function FileTree() {
  const sortedFiles = () => {
    const all = files();
    // Show directories first, then files, alphabetically
    return [...all].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  };

  return html`
    <div class="file-tree y-scroll">
      <${Show} when=${() => !activeProject()}>
        <div class="file-tree-empty y-text-sm y-text-muted">No project open</div>
      <//>
      <${Show} when=${() => activeProject()}>
        <${For} each=${sortedFiles}>
          ${(entry: FileEntry) => {
            const name = basename(entry.path);
            const icon = getIcon(entry.path, entry.isDirectory);
            const indent = (entry.path.split('/').length - 1) * 12;
            return html`
              <div
                class=${() =>
                  `file-tree-item${openFilePath() === entry.path ? ' active' : ''}${entry.isDirectory ? ' dir' : ''}`}
                style=${`padding-left: ${8 + indent}px`}
                onClick=${() => {
                  if (!entry.isDirectory) openFile(entry.path);
                }}
              >
                <span class="file-icon">${icon}</span>
                <span class="file-name">${name}</span>
              </div>
            `;
          }}
        <//>
      <//>
    </div>
  `;
}

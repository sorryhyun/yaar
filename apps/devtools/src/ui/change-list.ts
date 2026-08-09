export {};
import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { formatClock } from '@bundled/yaar';
import { fileChanges, selectedChangeId, type FileChange } from '../core';
import { selectChange } from '../services';

// The change-history list. Split out of changes-panel.ts so that file holds the
// diff rendering and this one holds the row markup; both are still one component
// tree, composed by ChangesPanel.

const KIND_ICON: Record<FileChange['kind'], string> = {
  create: '➕',
  update: '✏️',
  delete: '🗑️',
};

/** Basename plus its directory, so a long path stays readable when it truncates. */
function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/');
  return cut === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** True when this row is the one the detail pane is showing. */
function isActive(change: FileChange, index: number): boolean {
  const id = selectedChangeId();
  // A null selection means "the newest", which is row 0 — the same fallback
  // currentChange() applies, so the highlight never disagrees with the diff.
  if (id === null) return index === 0;
  return id === change.id;
}

export function ChangeList() {
  return html`
    <div class="changes-list y-scroll">
      <${Show} when=${() => fileChanges().length === 0}>
        <div class="diagnostics-empty y-text-xs y-text-muted">No file changes yet</div>
      <//>
      <${For} each=${fileChanges}>
        ${(change: FileChange, index: () => number) => html`
          <div
            class=${() =>
              `change-item${isActive(change, index()) ? ' active' : ''} ${change.kind}`}
            onClick=${() => selectChange(change.id)}
          >
            <span class="change-kind">${KIND_ICON[change.kind]}</span>
            <span class="change-path y-text-xs y-truncate">
              <span class="change-dir">${splitPath(change.path).dir}</span
              ><span class="change-name">${splitPath(change.path).name}</span>
            </span>
            <span class="change-stats y-text-xs">
              <${Show} when=${() => change.added > 0}>
                <span class="change-added">+${change.added}</span>
              <//>
              <${Show} when=${() => change.removed > 0}>
                <span class="change-removed">-${change.removed}</span>
              <//>
            </span>
            <span class="change-time y-text-xs">${formatClock(change.timestamp)}</span>
          </div>
        `}
      <//>
    </div>
  `;
}

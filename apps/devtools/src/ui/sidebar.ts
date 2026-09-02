export {};
import { createEffect, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { fileChanges } from '../core';
import { clearChanges } from '../services';
import { FileTree } from './file-tree';
import { ChangeList } from './change-list';
import { WorkerPanel } from './worker-panel';
import { sidebarTab, showChanges, showFiles, showWorker } from './panel-state';
import { workerStatus } from '../services';

// The left pane: file tree, change history, and the worker sub-agent as tabs
// of one sidebar.
//
// Files and Changes both answer "which files are in play", so they belong in
// the same column; the change history used to sit in the bottom panel next to
// Problems and Console, where it was a list of paths a long way from the tree
// of paths. The worker lives here too because its answers are about those same
// files — it cites paths, and the tree and editor are where a citation leads.

/**
 * Bring the Changes tab forward when a new change lands.
 *
 * The list is worth nothing if the reader has to know to go looking for it — the
 * complaint being answered here is that a write announced itself as one line of
 * status text and nothing else. Driven by watching the signal rather than by a
 * call from the recorder: services must not reach into UI state, and this keeps
 * the tab logic in the component that owns the tabs.
 *
 * The exception is the user's own typing. The editor autosaves, so every pause
 * mid-edit records a change; raising the sidebar then would pull the file tree
 * out from under someone who is looking at their code. In the bottom panel this
 * cost nothing, because the tree was a different column. Here it is the same one.
 */
function followNewChanges(): void {
  let seen = fileChanges().length;
  createEffect(() => {
    const count = fileChanges().length;
    if (count > seen && !editorHasFocus()) showChanges();
    seen = count;
  });
}

function editorHasFocus(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && el.classList.contains('editor-textarea');
}

export function Sidebar() {
  followNewChanges();
  return html`
    <div class="y-sidebar sidebar-pane">
      <div class="sidebar-tabs">
        <button
          class=${() => `sidebar-tab y-text-xs${sidebarTab() === 'files' ? ' active' : ''}`}
          onClick=${showFiles}
          title="Project files"
        >
          Files
        </button>
        <button
          class=${() => `sidebar-tab y-text-xs${sidebarTab() === 'changes' ? ' active' : ''}`}
          onClick=${showChanges}
          title="Files this session changed"
        >
          Changes
          <${Show} when=${() => fileChanges().length > 0}>
            <span class="diagnostics-count y-badge y-badge-accent"
              >${() => fileChanges().length}</span
            >
          <//>
        </button>
        <button
          class=${() => `sidebar-tab y-text-xs${sidebarTab() === 'worker' ? ' active' : ''}`}
          onClick=${showWorker}
          title="Worker sub-agent — a sonnet explorer for the active project"
        >
          Worker
          <${Show} when=${() => workerStatus() === 'running' || workerStatus() === 'spawning'}>
            <span class="y-dot y-dot-accent y-dot-pulse"></span>
          <//>
        </button>
        <${Show} when=${() => sidebarTab() === 'changes' && fileChanges().length > 0}>
          <button class="sidebar-tab-action y-text-xs" onClick=${() => clearChanges()}>
            Clear
          </button>
        <//>
      </div>
      <${Show} when=${() => sidebarTab() === 'files'}>
        <${FileTree} />
      <//>
      <${Show} when=${() => sidebarTab() === 'changes'}>
        <${ChangeList} />
      <//>
      <${Show} when=${() => sidebarTab() === 'worker'}>
        <${WorkerPanel} />
      <//>
    </div>
  `;
}

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

/**
 * Bring the Changes tab forward when a new change lands.
 *
 * Driven by watching the signal rather than by a call from the recorder: services
 * must not reach into UI state.
 *
 * The exception is the user's own typing. The editor autosaves, so every pause
 * mid-edit records a change; raising the Changes tab then would pull the file tree
 * out from under someone who is looking at their code.
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
      <div class="y-tabs dt-tabs sidebar-tabs">
        <button
          class=${() => `y-tab dt-tab sidebar-tab${sidebarTab() === 'files' ? ' active' : ''}`}
          onClick=${showFiles}
          title="Project files"
        >
          Files
        </button>
        <button
          class=${() => `y-tab dt-tab sidebar-tab${sidebarTab() === 'changes' ? ' active' : ''}`}
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
          class=${() => `y-tab dt-tab sidebar-tab${sidebarTab() === 'worker' ? ' active' : ''}`}
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

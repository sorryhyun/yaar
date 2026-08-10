export {};
import { createSignal, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { diagnostics, consoleLogs, type Diagnostic } from '../core';
import { openFile, clearConsoleLogs } from '../services';
import { ConsolePanel } from './console-panel';
import { showFiles } from './panel-state';

// The bottom panel: Problems and Console, and nothing else.
//
// Changes was a third tab here until it moved to the sidebar (see sidebar.ts and
// changes-panel.ts). What is left are the two short, scrolling logs the panel was
// sized for — which is why the `:has(.changes-panel)` height overrides went with
// it, and why this panel is back to a plain 200px cap.

const [activeBottomTab, setActiveBottomTab] = createSignal<'problems' | 'console'>('problems');

function ProblemsPanel() {
  return html`
    <div class="diagnostics-list y-scroll">
      <${Show} when=${() => diagnostics().length === 0}>
        <div class="diagnostics-empty y-text-xs y-text-muted">No problems</div>
      <//>
      <${For} each=${diagnostics}>
        ${(d: Diagnostic) => html`
          <div
            class=${`diagnostics-item ${d.severity}`}
            onClick=${() => {
              // The editor is not necessarily what the main pane is showing — a diff
              // may be. Jumping to a problem has to bring the file forward too, or
              // the click opens a file nobody can see.
              showFiles();
              openFile(d.file);
            }}
          >
            <span class="diag-icon">${d.severity === 'error' ? '❌' : '⚠️'}</span>
            <span class="diag-location y-text-xs">${d.file}:${d.line}</span>
            <span class="diag-message y-text-xs">${d.message}</span>
          </div>
        `}
      <//>
    </div>
  `;
}

export function DiagnosticsPanel() {
  return html`
    <div class="diagnostics">
      <div class="bottom-tabs">
        <button
          class=${() => `bottom-tab y-text-xs${activeBottomTab() === 'problems' ? ' active' : ''}`}
          onClick=${() => setActiveBottomTab('problems')}
        >
          Problems
          <${Show} when=${() => diagnostics().length > 0}>
            <span class="diagnostics-count y-badge y-badge-error"
              >${() => diagnostics().length}</span
            >
          <//>
        </button>
        <button
          class=${() => `bottom-tab y-text-xs${activeBottomTab() === 'console' ? ' active' : ''}`}
          onClick=${() => setActiveBottomTab('console')}
        >
          Console
          <${Show} when=${() => consoleLogs().length > 0}>
            <span class="diagnostics-count y-badge">${() => consoleLogs().length}</span>
          <//>
        </button>
        <${Show} when=${() => activeBottomTab() === 'console' && consoleLogs().length > 0}>
          <button class="bottom-tab-action y-text-xs" onClick=${() => clearConsoleLogs()}>
            Clear
          </button>
        <//>
      </div>
      <${Show} when=${() => activeBottomTab() === 'problems'}>
        <${ProblemsPanel} />
      <//>
      <${Show} when=${() => activeBottomTab() === 'console'}>
        <${ConsolePanel} />
      <//>
    </div>
  `;
}

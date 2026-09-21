export {};
import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { diagnostics, consoleLogs, type Diagnostic } from '../core';
import { openFile, clearConsoleLogs } from '../services';
import { ConsolePanel } from './console-panel';
import {
  bottomTab,
  bottomCollapsed,
  setBottomCollapsed,
  showBottomTab,
  showFiles,
  type BottomTab,
} from './panel-state';
import { Icon } from './icons';

// The bottom panel: Problems and Console, and nothing else (Changes is a sidebar tab).

/** A click on the tab already showing folds the panel away; any other click opens it. */
function onTabClick(tab: BottomTab): void {
  if (bottomTab() === tab && !bottomCollapsed()) setBottomCollapsed(true);
  else showBottomTab(tab);
}

const isShowing = (tab: BottomTab) => bottomTab() === tab && !bottomCollapsed();

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
            <span class="diag-icon">${d.severity === 'error' ? '✕' : '!'}</span>
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
    <div class=${() => `diagnostics${bottomCollapsed() ? ' collapsed' : ''}`}>
      <div class="y-tabs dt-tabs bottom-tabs">
        <button
          class=${() => `y-tab dt-tab bottom-tab${isShowing('problems') ? ' active' : ''}`}
          onClick=${() => onTabClick('problems')}
        >
          Problems
          <${Show} when=${() => diagnostics().length > 0}>
            <span class="diagnostics-count y-badge y-badge-error"
              >${() => diagnostics().length}</span
            >
          <//>
        </button>
        <button
          class=${() => `y-tab dt-tab bottom-tab${isShowing('console') ? ' active' : ''}`}
          onClick=${() => onTabClick('console')}
        >
          Console
          <${Show} when=${() => consoleLogs().length > 0}>
            <span class="diagnostics-count y-badge">${() => consoleLogs().length}</span>
          <//>
        </button>
        <span class="bottom-tab-actions">
          <${Show} when=${() => isShowing('console') && consoleLogs().length > 0}>
            <button class="bottom-tab-action y-text-xs" onClick=${() => clearConsoleLogs()}>
              Clear
            </button>
          <//>
          <button
            class="bottom-tab-action y-text-xs"
            title=${() => (bottomCollapsed() ? 'Expand panel' : 'Collapse panel')}
            onClick=${() => setBottomCollapsed(!bottomCollapsed())}
          >
            ${Icon('chevron', 'bottom-collapse-icon')}
          </button>
        </span>
      </div>
      <${Show} when=${() => isShowing('problems')}>
        <${ProblemsPanel} />
      <//>
      <${Show} when=${() => isShowing('console')}>
        <${ConsolePanel} />
      <//>
    </div>
  `;
}

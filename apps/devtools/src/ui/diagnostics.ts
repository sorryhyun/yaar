export {};
import { createEffect, createSignal, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { diagnostics, consoleLogs, fileChanges, type Diagnostic } from '../core';
import { openFile, clearConsoleLogs, clearChanges } from '../services';
import { ConsolePanel } from './console-panel';
import { ChangesPanel } from './changes-panel';

const [activeBottomTab, setActiveBottomTab] = createSignal<'problems' | 'console' | 'changes'>(
  'problems',
);

/**
 * Bring the Changes tab forward when a new change lands.
 *
 * The panel is worth nothing if the reader has to know to go looking for it — the
 * complaint being answered here is that a write announced itself as one line of
 * status text and nothing else. Driven by watching the signal rather than by a call
 * from the recorder: services must not reach into UI state, and this keeps the tab
 * logic in the component that owns the tabs.
 */
function followNewChanges(): void {
  let seen = fileChanges().length;
  createEffect(() => {
    const count = fileChanges().length;
    if (count > seen) setActiveBottomTab('changes');
    seen = count;
  });
}

function ProblemsPanel() {
  return html`
    <div class="diagnostics-list y-scroll">
      <${Show} when=${() => diagnostics().length === 0}>
        <div class="diagnostics-empty y-text-xs y-text-muted">No problems</div>
      <//>
      <${For} each=${diagnostics}>
        ${(d: Diagnostic) => html`
          <div class=${`diagnostics-item ${d.severity}`} onClick=${() => openFile(d.file)}>
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
  followNewChanges();
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
        <button
          class=${() => `bottom-tab y-text-xs${activeBottomTab() === 'changes' ? ' active' : ''}`}
          onClick=${() => setActiveBottomTab('changes')}
        >
          Changes
          <${Show} when=${() => fileChanges().length > 0}>
            <span class="diagnostics-count y-badge y-badge-accent"
              >${() => fileChanges().length}</span
            >
          <//>
        </button>
        <${Show} when=${() => activeBottomTab() === 'console' && consoleLogs().length > 0}>
          <button class="bottom-tab-action y-text-xs" onClick=${() => clearConsoleLogs()}>
            Clear
          </button>
        <//>
        <${Show} when=${() => activeBottomTab() === 'changes' && fileChanges().length > 0}>
          <button class="bottom-tab-action y-text-xs" onClick=${() => clearChanges()}>Clear</button>
        <//>
      </div>
      <${Show} when=${() => activeBottomTab() === 'problems'}>
        <${ProblemsPanel} />
      <//>
      <${Show} when=${() => activeBottomTab() === 'console'}>
        <${ConsolePanel} />
      <//>
      <${Show} when=${() => activeBottomTab() === 'changes'}>
        <${ChangesPanel} />
      <//>
    </div>
  `;
}

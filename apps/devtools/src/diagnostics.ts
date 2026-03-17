export {};
import { createSignal, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { diagnostics, openFile, consoleLogs, clearConsoleLogs } from './project';
import type { Diagnostic } from './project';
import { ConsolePanel } from './console-panel';

const [activeBottomTab, setActiveBottomTab] = createSignal<'problems' | 'console'>('problems');

function ProblemsPanel() {
  return html`
    <div class="diagnostics-list y-scroll">
      <${Show} when=${() => diagnostics().length === 0}>
        <div class="diagnostics-empty y-text-xs y-text-muted">No problems</div>
      <//>
      <${For} each=${diagnostics}>
        ${(d: Diagnostic) => html`
          <div class=${`diagnostics-item ${d.severity}`} onClick=${() => openFile(d.file)}>
            <span class="diag-icon">${d.severity === 'error' ? '\u274c' : '\u26a0\ufe0f'}</span>
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
            <span class="diagnostics-count y-badge y-badge-error">${() => diagnostics().length}</span>
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
          <button class="bottom-tab-action y-text-xs" onClick=${() => clearConsoleLogs()}>Clear</button>
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

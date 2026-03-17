export {};
import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { diagnostics, openFile } from './project';
import type { Diagnostic } from './project';

export function DiagnosticsPanel() {
  return html`
    <div class="diagnostics">
      <div class="diagnostics-header y-text-xs y-text-muted">
        Problems
        <${Show} when=${() => diagnostics().length > 0}>
          <span class="diagnostics-count y-badge y-badge-error"
            >${() => diagnostics().length}</span
          >
        <//>
      </div>
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
    </div>
  `;
}

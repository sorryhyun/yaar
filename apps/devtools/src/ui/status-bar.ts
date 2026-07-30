export {};
import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { activeProject, bundleStatus, statusText } from '../core';

/**
 * Compile state and active-project context shown at the bottom of the workspace.
 *
 * The dot tracks the *bundler* — the user reads type errors in the diagnostics
 * panel beside it, so folding them in here would only make one light stand for two
 * things. `compileStatus` in the protocol does combine them, because an agent has
 * no panel to look at.
 */
export function StatusBar() {
  return html`
    <div class="statusbar">
      <div class="y-flex" style="gap: 6px; align-items: center">
        <span
          class=${() => `status-indicator ${bundleStatus() === 'idle' ? '' : bundleStatus()}`}
        ></span>
        <span>${statusText}</span>
      </div>
      <${Show} when=${() => activeProject()}>
        <span>${() => activeProject()?.name ?? ''}</span>
      <//>
    </div>
  `;
}

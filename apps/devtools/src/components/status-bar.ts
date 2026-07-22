export {};
import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { activeProject, compileStatus, statusText } from '../project';

/** Compile state and active-project context shown at the bottom of the workspace. */
export function StatusBar() {
  return html`
    <div class="statusbar">
      <div class="y-flex" style="gap: 6px; align-items: center">
        <span
          class=${() =>
            `status-indicator ${compileStatus() === 'idle' ? '' : compileStatus()}`}
        ></span>
        <span>${statusText}</span>
      </div>
      <${Show} when=${() => activeProject()}>
        <span>${() => activeProject()?.name ?? ''}</span>
      <//>
    </div>
  `;
}

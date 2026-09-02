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
const DOT_CLASS: Record<ReturnType<typeof bundleStatus>, string> = {
  idle: 'y-dot',
  compiling: 'y-dot y-dot-accent y-dot-pulse',
  success: 'y-dot y-dot-ok',
  error: 'y-dot y-dot-err',
};

export function StatusBar() {
  return html`
    <div class="y-statusbar y-statusbar-dense">
      <div class="y-flex" style="gap: 6px; align-items: center">
        <span class=${() => DOT_CLASS[bundleStatus()]}></span>
        <span>${statusText}</span>
      </div>
      <${Show} when=${() => activeProject()}>
        <span>${() => activeProject()?.name ?? ''}</span>
      <//>
    </div>
  `;
}

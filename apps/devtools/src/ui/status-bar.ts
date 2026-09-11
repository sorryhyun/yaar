export {};
import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { activeProject, bundleStatus, diagnostics, openFilePath, statusText } from '../core';
import { cursorPos } from './editor';
import { showBottomTab } from './panel-state';

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

const LANGUAGE: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  css: 'CSS',
  html: 'HTML',
  json: 'JSON',
  md: 'Markdown',
};

const language = () => {
  const ext = openFilePath()?.split('.').pop() ?? '';
  return LANGUAGE[ext] ?? '';
};

const count = (severity: 'error' | 'warning') =>
  diagnostics().filter((d) => d.severity === severity).length;

export function StatusBar() {
  return html`
    <div class="y-statusbar y-statusbar-dense">
      <div class="status-left">
        <span class=${() => DOT_CLASS[bundleStatus()]}></span>
        <span class="y-truncate">${statusText}</span>
      </div>
      <div class="status-right">
        <${Show} when=${cursorPos}>
          <span>Ln ${() => cursorPos()?.line}, Col ${() => cursorPos()?.col}</span>
        <//>
        <${Show} when=${language}>
          <span>${language}</span>
        <//>
        <${Show} when=${() => activeProject()}>
          <button
            class="status-problems"
            title="Show problems"
            onClick=${() => showBottomTab('problems')}
          >
            <span class=${() => (count('error') ? 'status-err' : '')}>✕ ${() => count('error')}</span>
            <span class=${() => (count('warning') ? 'status-warn' : '')}
              >⚠ ${() => count('warning')}</span
            >
          </button>
          <span class="status-project y-truncate">${() => activeProject()?.name ?? ''}</span>
        <//>
      </div>
    </div>
  `;
}

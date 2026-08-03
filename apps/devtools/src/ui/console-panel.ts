export {};
import { For, Show, onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { formatClock } from '@bundled/yaar';
import { consoleLogs, type ConsoleEntry } from '../core';
import { addConsoleEntry } from '../services';

function levelIcon(level: string): string {
  if (level === 'error') return '❌';
  if (level === 'warn') return '⚠️';
  if (level === 'info') return 'ℹ️';
  return '●';
}

export function ConsolePanel() {
  function onMessage(e: MessageEvent) {
    if (e.data?.type === 'yaar:console') {
      addConsoleEntry({
        level: e.data.level,
        args: e.data.args,
        timestamp: e.data.timestamp,
      });
    }
  }

  onMount(() => window.addEventListener('message', onMessage));
  onCleanup(() => window.removeEventListener('message', onMessage));

  return html`
    <div class="console-list y-scroll">
      <${Show} when=${() => consoleLogs().length === 0}>
        <div class="diagnostics-empty y-text-xs y-text-muted">No console output</div>
      <//>
      <${For} each=${consoleLogs}>
        ${(entry: ConsoleEntry) => html`
          <div class=${`console-entry ${entry.level}`}>
            <span class="console-level">${levelIcon(entry.level)}</span>
            <span class="console-time y-text-xs">${formatClock(entry.timestamp)}</span>
            <span class="console-args y-text-xs">${entry.args.join(' ')}</span>
          </div>
        `}
      <//>
    </div>
  `;
}

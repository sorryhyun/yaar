export {};
import { For, Show, onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { consoleLogs, addConsoleEntry } from './project';
import type { ConsoleEntry } from './project';

function levelIcon(level: string): string {
  if (level === 'error') return '\u274c';
  if (level === 'warn') return '\u26a0\ufe0f';
  if (level === 'info') return '\u2139\ufe0f';
  return '\u25cf';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
            <span class="console-time y-text-xs">${formatTime(entry.timestamp)}</span>
            <span class="console-args y-text-xs">${entry.args.join(' ')}</span>
          </div>
        `}
      <//>
    </div>
  `;
}

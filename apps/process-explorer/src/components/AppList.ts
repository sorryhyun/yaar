export {};

import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { appProcesses, closeAppWindows, killAppAgent } from '../data';
import { statusDotClass } from '../theme';
import type { AppProcess } from '../types';
import { ProcessList } from './ProcessList';

function AppRow(props: { proc: AppProcess }) {
  const p = () => props.proc;

  // A busy agent is doing work; an orphan is holding a slot for nothing. Either
  // is a reason to look at this row.
  const dotClass = () => statusDotClass(Boolean(p().agent?.busy) || p().orphaned);

  const agentLabel = () => {
    const agent = p().agent;
    if (!agent) return 'no agent';
    return agent.busy ? 'agent busy' : 'agent idle';
  };

  const windowLabel = () => {
    const n = p().windows.length;
    return n === 1 ? '1 window' : `${n} windows`;
  };

  return html`
    <div class="y-list-item process-row">
      <div class="process-info">
        <span class=${dotClass}></span>
        <div class="process-detail">
          <div class="process-title">${() => p().name}</div>
          <div class="process-meta">
            <span>${windowLabel}</span>
            <span>${agentLabel}</span>
            ${() =>
              p().orphaned
                ? html`<span
                    class="y-badge"
                    title="Agent still holds a slot and its context, with no window open"
                    >orphaned</span
                  >`
                : null}
          </div>
        </div>
      </div>
      <div class="process-actions">
        <${Show} when=${() => p().windows.length > 0}>
          <button
            class="y-btn y-btn-ghost y-btn-sm"
            onClick=${() => closeAppWindows(p().appId)}
            title="Close all windows of this app"
          >
            Close
          </button>
        </>
        <${Show} when=${() => p().agent !== null}>
          <button
            class="y-btn y-btn-ghost y-btn-sm y-btn-danger"
            onClick=${() => killAppAgent(p().appId)}
            title="Dispose the app agent, freeing its slot and dropping its context"
          >
            Kill
          </button>
        </>
      </div>
    </div>
  `;
}

export function AppList() {
  return html`
    <${ProcessList} each=${appProcesses} icon="▣" emptyText="No apps running"
      >${(proc: AppProcess) => html`<${AppRow} proc=${proc} />`}</
    >
  `;
}

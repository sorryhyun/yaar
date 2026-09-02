import { createSignal, onMount, Index, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showToast } from '@bundled/yaar';
import { bootstrap, saveCurrent } from '../state/persistence';
import { addCell, clearAllOutputs, renameNotebook } from '../state/cells';
import { current, dirty, status } from '../state/signals';
import { lastRun, runAll, setTimeoutMs, timeoutMs } from '../state/run';
import { mainView, setMainView, unseen } from '../state/agent-runs';
import { busy, cancelRun, resetKernel } from '../kernel/worker';
import { AgentPanel } from './AgentPanel';
import { CellRow } from './CellRow';
import { Sidebar } from './Sidebar';
import type { Cell } from '../types';

const [sidebar, setSidebar] = createSignal(true);

/** The notebook itself — one of the two things the main pane can show. */
function NotebookView() {
  const cells = () => current()?.cells || [];
  return html`
    <div class="lab-cells">
      <${Index} each=${cells}>${(cell: () => Cell, i: number) => CellRow(cell, i)}<//>
      <div class="lab-add-row">
        <button class="lab-btn" onClick=${() => addCell('', 'code')}>+ Add cell</button>
      </div>
    </div>`;
}

/**
 * App shell: sidebar toggle, toolbar, the main pane (notebook OR agent run log,
 * switched by the tabs) and the status bar. Layout is absolute positioning
 * throughout, not flex chains — Solid's `html` inserts comment markers into
 * reactive slots and breaks `flex: 1`.
 */
export default function App() {
  onMount(() => {
    void bootstrap();
  });

  const onNotebook = () => mainView() === 'notebook';

  return html`
    <div class=${() => 'lab-root' + (sidebar() ? '' : ' lab-no-side')}>
      ${() => (sidebar() ? Sidebar() : null)}
      <div class="lab-main">
        <div class="y-toolbar lab-toolbar">
          <button class="lab-mini" title="Toggle notebook list" onClick=${() => setSidebar(!sidebar())}>☰</button>
          <input
            class="lab-title"
            value=${() => current()?.title || ''}
            placeholder="Untitled"
            onInput=${(e: Event) => renameNotebook((e.target as HTMLInputElement).value)}
          />
          <div class="lab-tabs">
            <button
              class=${() => 'lab-tab' + (onNotebook() ? ' lab-tab-on' : '')}
              title="The notebook"
              onClick=${() => setMainView('notebook')}
            >Notebook</button>
            <button
              class=${() => 'lab-tab' + (onNotebook() ? '' : ' lab-tab-on')}
              title="Agent runs — everything started over the app protocol"
              onClick=${() => setMainView('agent')}
            >🤖 Agent runs<${Show} when=${() => unseen() > 0}><span class="lab-tab-badge">${unseen}</span><//></button>
          </div>
          <span class="lab-spacer"></span>
          <${Show} when=${onNotebook}>
            <button class="lab-btn" disabled=${busy} onClick=${() => void runAll()}>▶▶ Run all</button>
            <button class="lab-btn" onClick=${() => addCell('', 'code')}>+ Code</button>
            <button class="lab-btn" onClick=${() => addCell('', 'markdown')}>+ Text</button>
            <button class="lab-btn" onClick=${() => clearAllOutputs()}>Clear out</button>
          <//>
          <button class="lab-btn" onClick=${() => {
            resetKernel();
            showToast('Kernel restarted', 'info');
          }}>Reset kernel</button>
          <label class="lab-timeout">
            timeout
            <input
              type="number"
              min="1"
              max="600"
              value=${() => Math.round(timeoutMs() / 1000)}
              onChange=${(e: Event) => setTimeoutMs(Math.max(1, Number((e.target as HTMLInputElement).value) || 30) * 1000)}
            />s
          </label>
        </div>
        ${() => (onNotebook() ? NotebookView() : AgentPanel())}
        <div class="y-statusbar lab-status">
          <${Show} when=${busy} fallback=${() => html`<span class="y-dot"></span><span>idle</span>`}>
            <span class="y-dot y-dot-warn y-dot-pulse"></span><span>running…</span>
            <button class="lab-mini lab-mini-danger" onClick=${() => cancelRun()}>Cancel</button>
          <//>
          <span class="lab-spacer"></span>
          <span class="lab-note">${() => status()}</span>
          <span class="lab-note">${() => {
            const r = lastRun();
            return r
              ? (r.ok ? 'last: ' : 'last failed: ') +
                  r.summary.slice(0, 90) +
                  ' (' +
                  r.durationMs +
                  'ms)'
              : '';
          }}</span>
          <span class="lab-note">${() => (dirty() ? 'unsaved' : 'saved')}</span>
          <button class="lab-mini" onClick=${async () => {
            (await saveCurrent()) && showToast('Saved', 'success');
          }}>Save</button>
        </div>
      </div>
    </div>`;
}

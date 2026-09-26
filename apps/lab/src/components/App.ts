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
import { autosize, editors } from './editor-registry';
import type { Cell } from '../types';

const [sidebar, setSidebar] = createSignal(true);

// Narrow and touch are read in JS, not only in CSS media queries: narrow changes what the
// sidebar IS (a drawer over the content, closed by default), and the root classes keep
// every breakpoint rule on one switch that previewEval can flip to test the layout.
const NARROW = '(max-width: 640px)';
const COARSE = '(pointer: coarse)';
const [narrow, setNarrow] = createSignal(matchMedia(NARROW).matches);
const [coarse, setCoarse] = createSignal(matchMedia(COARSE).matches);
const [drawer, setDrawer] = createSignal(false);
const [menu, setMenu] = createSignal(false);
matchMedia(NARROW).addEventListener('change', (e) => {
  setNarrow(e.matches);
  setDrawer(false);
  setMenu(false);
  // The code editor wraps on one side of the breakpoint and scrolls on the other.
  editors.forEach((el) => el.isConnected && autosize(el));
});
matchMedia(COARSE).addEventListener('change', (e) => setCoarse(e.matches));

function toggleSidebar(): void {
  if (narrow()) setDrawer(!drawer());
  else setSidebar(!sidebar());
}

function SidePane() {
  if (!narrow()) return sidebar() ? Sidebar() : null;
  if (!drawer()) return null;
  return html`
    <div class="lab-side-scrim" onClick=${() => setDrawer(false)}></div>
    ${Sidebar(() => setDrawer(false))}`;
}

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
    <div
      class=${() =>
        'lab-root' +
        (sidebar() ? '' : ' lab-no-side') +
        (narrow() ? ' lab-narrow' : '') +
        (coarse() ? ' lab-touch' : '')}
    >
      ${SidePane}
      <div class="lab-main">
        <div class="y-toolbar lab-toolbar">
          <button class="lab-mini" title="Toggle notebook list" onClick=${toggleSidebar}>☰</button>
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
            ><span class="lab-tab-ico">📓</span><span class="lab-lbl">Notebook</span></button>
            <button
              class=${() => 'lab-tab' + (onNotebook() ? '' : ' lab-tab-on')}
              title="Agent runs — everything started over the app protocol"
              onClick=${() => setMainView('agent')}
            >🤖<span class="lab-lbl"> Agent runs</span><${Show} when=${() => unseen() > 0}><span class="lab-tab-badge">${unseen}</span><//></button>
          </div>
          <span class="lab-spacer"></span>
          <${Show} when=${onNotebook}>
            <button class="lab-btn" title="Run all cells" disabled=${busy} onClick=${() => void runAll()}>▶▶<span class="lab-lbl"> Run all</span></button>
          <//>
          <button
            class="lab-btn lab-more"
            title="More actions"
            onClick=${() => setMenu(!menu())}
          >⋯</button>
          <${Show} when=${menu}>
            <div class="lab-menu-scrim" onClick=${() => setMenu(false)}></div>
          <//>
          <div
            class=${() => 'lab-actions' + (menu() ? ' lab-actions-open' : '')}
            onClick=${(e: MouseEvent) => (e.target as HTMLElement).closest('button') && setMenu(false)}
          >
            <${Show} when=${onNotebook}>
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
        </div>
        ${() => (onNotebook() ? NotebookView() : AgentPanel())}
        <div class="y-statusbar lab-status">
          <${Show} when=${busy} fallback=${() => html`<span class="y-dot"></span><span>idle</span>`}>
            <span class="y-dot y-dot-warn y-dot-pulse"></span><span>running…</span>
            <button class="lab-mini lab-mini-danger" onClick=${() => cancelRun()}>Cancel</button>
          <//>
          <span class="lab-spacer"></span>
          <span class="lab-note">${() => status()}</span>
          <span class="lab-note lab-last">${() => {
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

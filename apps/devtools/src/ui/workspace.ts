export {};
import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { Sidebar } from './sidebar';
import { Editor } from './editor';
import { ChangeView } from './changes-panel';
import { DiagnosticsPanel } from './diagnostics';
import { drawerOpen, mainView, setDrawerOpen, sidebarTab } from './panel-state';

export function Workspace() {
  // Whether a drawer exists at all is CSS's call (sidebar.css, ≤768px); the open
  // flag only says whether it is out.
  return html`
    <div
      class=${() =>
        `main-area${sidebarTab() === 'files' ? '' : ' wide-sidebar'}${drawerOpen() ? ' drawer-open' : ''}`}
    >
      <${Sidebar} />
      <${Show} when=${drawerOpen}>
        <div class="y-nav-backdrop dt-drawer-backdrop" onClick=${() => setDrawerOpen(false)}></div>
      <//>
      <div class="editor-area">
        <${Show} when=${() => mainView() === 'changes'} fallback=${html`<${Editor} />`}>
          <${ChangeView} />
        <//>
        <${DiagnosticsPanel} />
      </div>
    </div>
  `;
}

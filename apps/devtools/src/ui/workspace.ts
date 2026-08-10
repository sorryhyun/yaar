export {};
import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { Sidebar } from './sidebar';
import { Editor } from './editor';
import { ChangeView } from './changes-panel';
import { DiagnosticsPanel } from './diagnostics';
import { mainView, sidebarTab } from './panel-state';

/** The persistent file navigation, editor, and lower utility panels. */
export function Workspace() {
  return html`
    <div class=${() => `main-area${sidebarTab() === 'changes' ? ' wide-sidebar' : ''}`}>
      <${Sidebar} />
      <div class="editor-area">
        <${Show} when=${() => mainView() === 'changes'} fallback=${html`<${Editor} />`}>
          <${ChangeView} />
        <//>
        <${DiagnosticsPanel} />
      </div>
    </div>
  `;
}

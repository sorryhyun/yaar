export {};
import html from '@bundled/solid-js/html';
import { FileTree } from './file-tree';
import { Editor } from './editor';
import { DiagnosticsPanel } from './diagnostics';

/** The persistent file navigation, editor, and lower utility panels. */
export function Workspace() {
  return html`
    <div class="main-area">
      <${FileTree} />
      <div class="editor-area">
        <${Editor} />
        <${DiagnosticsPanel} />
      </div>
    </div>
  `;
}

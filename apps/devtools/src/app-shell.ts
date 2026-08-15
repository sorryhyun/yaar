export {};
import html from '@bundled/solid-js/html';
import { ProjectToolbar } from './ui/project-toolbar';
import { StatusBar } from './ui/status-bar';
import { Workspace } from './ui/workspace';

export function AppShell() {
  return html`
    <div class="devtools">
      <${ProjectToolbar} />
      <${Workspace} />
      <${StatusBar} />
    </div>
  `;
}

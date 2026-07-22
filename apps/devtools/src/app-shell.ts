export {};
import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { openTabs } from './project';
import { ProjectToolbar } from './components/project-toolbar';
import { ProjectTabs } from './components/project-tabs';
import { StatusBar } from './components/status-bar';
import { Workspace } from './components/workspace';

/** Composes the focused chrome and workspace components into the IDE layout. */
export function AppShell() {
  return html`
    <div class="devtools">
      <${ProjectToolbar} />
      <${Show} when=${() => openTabs().length > 0}>
        <${ProjectTabs} />
      <//>
      <${Workspace} />
      <${StatusBar} />
    </div>
  `;
}

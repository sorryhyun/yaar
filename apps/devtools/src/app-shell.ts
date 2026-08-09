export {};
import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { openTabs } from './core';
import { ProjectToolbar } from './ui/project-toolbar';
import { ProjectTabs } from './ui/project-tabs';
import { StatusBar } from './ui/status-bar';
import { Workspace } from './ui/workspace';

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
    
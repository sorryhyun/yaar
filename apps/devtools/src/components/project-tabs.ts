export {};
import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { activeProject, projects, openTabs, openProject, closeTab } from '../project';

/** Open-project tabs and their selection/close behavior. */
export function ProjectTabs() {
  return html`
    <div class="tab-bar">
      <${For} each=${openTabs}>
        ${(tabId: string) => {
          const project = () => projects().find((item) => item.id === tabId);
          return html`
            <div
              class=${() => `tab${activeProject()?.id === tabId ? ' active' : ''}`}
              onClick=${() => openProject(tabId)}
            >
              <span class="tab-name">${() => project()?.name ?? tabId}</span>
              <span
                class="tab-close"
                onClick=${(event: Event) => {
                  event.stopPropagation();
                  closeTab(tabId);
                }}
              >×</span>
            </div>
          `;
        }}
      <//>
    </div>
  `;
}

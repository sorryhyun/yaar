export {};
import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { app } from '@bundled/yaar';
import './styles.css';
import {
  activeProject,
  projects,
  compileStatus,
  statusText,
  previewUrl,
  loadProjects,
  createProject,
  openProject,
  compile,
  typecheck,
} from './project';
import { FileTree } from './file-tree';
import { Editor } from './editor';
import { DiagnosticsPanel } from './diagnostics';
import { registerProtocol } from './protocol';

// ── App Shell ──

const App = () => html`
  <div class="devtools">
    <div class="toolbar">
      <select
        class="project-select y-select"
        onChange=${(e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          if (val === '__new__') {
            const name = prompt('Project name:');
            if (name?.trim()) createProject(name.trim());
            (e.target as HTMLSelectElement).value = activeProject()?.id ?? '';
          } else if (val) {
            openProject(val);
          }
        }}
      >
        <option value="" disabled>Select project...</option>
        ${() =>
          projects().map(
            (p) => html`
              <option value=${p.id} selected=${() => activeProject()?.id === p.id}>${p.name}</option>
            `
          )}
        <option value="__new__">+ New Project</option>
      </select>

      <button
        class="y-btn y-btn-sm"
        disabled=${() => !activeProject()}
        onClick=${() => typecheck()}
        title="Type check"
      >
        Typecheck
      </button>

      <button
        class="y-btn y-btn-sm y-btn-primary"
        disabled=${() => !activeProject()}
        onClick=${() => compile()}
        title="Compile"
      >
        Compile
      </button>

      <button
        class="y-btn y-btn-sm"
        disabled=${() => !activeProject() || !previewUrl()}
        onClick=${() => {
          const url = previewUrl();
          if (url) {
            app?.sendInteraction({
              event: 'preview_request',
              previewUrl: url,
              projectName: activeProject()?.name ?? 'Preview',
            });
          }
        }}
        title="Open preview window"
      >
        Preview
      </button>
    </div>

    <div class="main-area">
      <${FileTree} />
      <div class="editor-area">
        <${Editor} />
        <${DiagnosticsPanel} />
      </div>
    </div>

    <div class="statusbar">
      <div class="y-flex" style="gap: 6px; align-items: center">
        <span
          class=${() =>
            `status-indicator ${compileStatus() === 'idle' ? '' : compileStatus()}`}
        ></span>
        <span>${() => statusText()}</span>
      </div>
      <${Show} when=${() => activeProject()}>
        <span>${() => activeProject()?.name ?? ''}</span>
      <//>
    </div>
  </div>
`;

render(App, document.getElementById('app')!);

// ── Init ──

registerProtocol();
loadProjects();

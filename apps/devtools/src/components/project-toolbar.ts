export {};
import html from '@bundled/solid-js/html';
import { app } from '@bundled/yaar';
import {
  activeProject,
  projects,
  previewUrl,
  createProject,
  openProject,
  compile,
} from '../project';

/** Project selection and build actions in the app chrome. */
export function ProjectToolbar() {
  function handleProjectChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    const projectId = select.value;

    if (projectId === '__new__') {
      const name = prompt('Project name:');
      if (name?.trim()) createProject(name.trim());
      select.value = activeProject()?.id ?? '';
      return;
    }

    if (projectId) openProject(projectId);
  }

  function requestPreview(): void {
    const url = previewUrl();
    if (!url) return;
    app?.sendInteraction({
      event: 'preview_request',
      previewUrl: url,
      projectName: activeProject()?.name ?? 'Preview',
    });
  }

  return html`
    <div class="toolbar">
      <select class="project-select y-select" onChange=${handleProjectChange}>
        <option value="" disabled>Open project...</option>
        ${() =>
          projects().map(
            (project) => html`
              <option value=${project.id} selected=${() => activeProject()?.id === project.id}>
                ${project.name}
              </option>
            `,
          )}
        <option value="__new__">+ New Project</option>
      </select>

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
        onClick=${requestPreview}
        title="Open preview window"
      >
        Preview
      </button>
    </div>
  `;
}

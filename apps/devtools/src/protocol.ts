export {};
import { app } from '@bundled/yaar';
import {
  activeProject,
  projects,
  openFilePath,
  openFileContent,
  diagnostics,
  compileStatus,
  previewUrl,
  files,
  createProject,
  openProject,
  deleteProject,
  openFile,
  writeFile,
  editFile,
  deleteFile,
  compile,
  typecheck,
  deploy,
} from './project';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'devtools',
    name: 'Devtools',
    state: {
      project: {
        description: 'Active project',
        handler: () => {
          const proj = activeProject();
          if (!proj) return null;
          return { ...proj, files: files().map((f) => f.path) };
        },
      },
      projects: {
        description: 'All projects',
        handler: () => [...projects()],
      },
      openFile: {
        description: 'Currently open file',
        handler: () => {
          const path = openFilePath();
          if (!path) return null;
          const ext = path.split('.').pop() ?? '';
          return { path, content: openFileContent(), language: ext };
        },
      },
      diagnostics: {
        description: 'TypeScript errors/warnings',
        handler: () => [...diagnostics()],
      },
      compileStatus: {
        description: 'Compilation state',
        handler: () => compileStatus(),
      },
      previewUrl: {
        description: 'URL of last successful compilation',
        handler: () => previewUrl(),
      },
    },
    commands: {
      createProject: {
        description: 'Create a new project',
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Project name' },
          },
          required: ['name'],
        },
        handler: async (p: Record<string, unknown>) => {
          const id = await createProject(String(p.name));
          return { ok: true, projectId: id };
        },
      },
      openProject: {
        description: 'Switch to an existing project',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p: Record<string, unknown>) => {
          await openProject(String(p.id));
          return { ok: true };
        },
      },
      deleteProject: {
        description: 'Delete a project',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p: Record<string, unknown>) => {
          await deleteProject(String(p.id));
          return { ok: true };
        },
      },
      openFile: {
        description: 'Open a file in the editor',
        params: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (p: Record<string, unknown>) => {
          await openFile(String(p.path));
          return { ok: true };
        },
      },
      writeFile: {
        description: 'Write content to a file',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
        handler: async (p: Record<string, unknown>) => {
          await writeFile(String(p.path), String(p.content));
          return { ok: true };
        },
      },
      editFile: {
        description: 'Edit a file',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            oldString: { type: 'string' },
            newString: { type: 'string' },
          },
          required: ['path', 'oldString', 'newString'],
        },
        handler: async (p: Record<string, unknown>) => {
          await editFile(String(p.path), String(p.oldString), String(p.newString));
          return { ok: true };
        },
      },
      deleteFile: {
        description: 'Delete a file',
        params: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (p: Record<string, unknown>) => {
          await deleteFile(String(p.path));
          return { ok: true };
        },
      },
      compile: {
        description: 'Compile the active project',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await compile();
          return { ok: true, status: compileStatus(), previewUrl: previewUrl() };
        },
      },
      typecheck: {
        description: 'Run TypeScript type checker',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await typecheck();
          return { ok: true, diagnostics: diagnostics() };
        },
      },
      deploy: {
        description: 'Deploy to apps/',
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            name: { type: 'string' },
            icon: { type: 'string' },
            description: { type: 'string' },
            permissions: { type: 'array', items: { type: 'string' } },
          },
          required: ['appId'],
        },
        handler: async (p: Record<string, unknown>) => {
          await deploy({
            appId: String(p.appId),
            name: p.name ? String(p.name) : undefined,
            icon: p.icon ? String(p.icon) : undefined,
            description: p.description ? String(p.description) : undefined,
            permissions: Array.isArray(p.permissions) ? p.permissions.map(String) : undefined,
          });
          return { ok: true };
        },
      },
      preview: {
        description: 'Request preview window',
        params: { type: 'object', properties: {} },
        handler: () => {
          const url = previewUrl();
          if (!url) return { ok: false, error: 'No compiled output. Run compile first.' };
          app?.sendInteraction({
            event: 'preview_request',
            previewUrl: url,
            projectName: activeProject()?.name ?? 'Preview',
          });
          return { ok: true, previewUrl: url };
        },
      },
    },
  });
}

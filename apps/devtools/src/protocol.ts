export {};
import { app, appStorage, invoke, read, describe, list } from '@bundled/yaar';
import {
  activeProject,
  projects,
  openFilePath,
  openFileContent,
  diagnostics,
  compileStatus,
  compileErrors,
  previewUrl,
  previewWindowId,
  setPreviewWindowId,
  files,
  bundledLibs,
  consoleLogs,
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
  cloneApp,
  clearConsoleLogs,
  grep,
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
        description: 'Currently open file (with line numbers)',
        handler: () => {
          const path = openFilePath();
          if (!path) return null;
          const raw = openFileContent();
          const ext = path.split('.').pop() ?? '';
          if (raw == null) return { path, content: null, language: ext };
          const lines = raw.split('\n');
          const width = String(lines.length).length;
          const numbered = lines
            .map((line, i) => `${String(i + 1).padStart(width)}│${line}`)
            .join('\n');
          return { path, content: `── ${path} (${lines.length} lines) ──\n${numbered}`, language: ext };
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
      compileErrors: {
        description: 'Compilation errors (if any)',
        handler: () => [...compileErrors()],
      },
      previewUrl: {
        description: 'URL of last successful compilation',
        handler: () => previewUrl(),
      },
      bundledLibraries: {
        description: 'Available @bundled/* import libraries',
        handler: () => [...bundledLibs()],
      },
      consoleLogs: {
        description: 'Console output from preview app',
        handler: () => [...consoleLogs()],
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
        description: 'Edit a file (search & replace)',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            search: { type: 'string', description: 'Text to find (alias: oldString)' },
            replace: { type: 'string', description: 'Replacement text (alias: newString)' },
          },
          required: ['path', 'search', 'replace'],
        },
        handler: async (p: Record<string, unknown>) => {
          const search = String(p.search ?? p.oldString);
          const replace = String(p.replace ?? p.newString);
          if (!search || search === 'undefined')
            return { ok: false, error: 'Missing search string' };
          const changed = await editFile(String(p.path), search, replace);
          if (!changed) return { ok: false, error: 'Search string not found in file' };
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
      grep: {
        description: 'Search file contents with regex across the project',
        params: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            glob: { type: 'string', description: 'File glob filter (e.g. "src/**/*.ts")' },
          },
          required: ['pattern'],
        },
        handler: async (p: Record<string, unknown>) => {
          const result = await grep(String(p.pattern), p.glob ? String(p.glob) : undefined);
          return { ok: true, ...result };
        },
      },
      compile: {
        description: 'Compile the active project',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await compile();
          const status = compileStatus();
          const errors = compileErrors();
          return {
            ok: true,
            status,
            previewUrl: previewUrl(),
            ...(status === 'error' && errors.length > 0 ? { errors } : {}),
          };
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
          },
          required: ['appId'],
        },
        handler: async (p: Record<string, unknown>) => {
          await deploy({
            appId: String(p.appId),
            name: p.name ? String(p.name) : undefined,
            icon: p.icon ? String(p.icon) : undefined,
            description: p.description ? String(p.description) : undefined,
          });
          return { ok: true };
        },
      },
      preview: {
        description: 'Open preview window for the compiled app',
        params: { type: 'object', properties: {} },
        handler: async () => {
          const url = previewUrl();
          if (!url) return { ok: false, error: 'No compiled output. Run compile first.' };
          const proj = activeProject();
          const name = proj?.name ?? 'Preview';
          // Read project's app.json to get declared permissions for the preview iframe
          let permissions: string[] | undefined;
          if (proj) {
            try {
              const appJson = await appStorage.readJson<{ permissions?: string[] }>(
                `projects/${proj.id}/app.json`,
              );
              if (Array.isArray(appJson?.permissions)) permissions = appJson.permissions;
            } catch {
              /* no app.json or no permissions */
            }
          }
          const result = await invoke<{ windowId?: string }>('yaar://windows/', {
            action: 'create',
            title: name,
            renderer: 'iframe',
            content: url,
            ...(permissions ? { permissions } : {}),
          });
          if (result?.windowId) setPreviewWindowId(result.windowId);
          return { ok: true, previewUrl: url, ...result };
        },
      },
      viewPreview: {
        description: 'Read the current preview window state (content, size, position)',
        params: { type: 'object', properties: {} },
        handler: async () => {
          const wid = previewWindowId();
          if (!wid) return { ok: false, error: 'No preview window open. Run preview first.' };
          try {
            const info = await read<Record<string, unknown>>(`yaar://windows/${wid}`);
            return { ok: true, ...info };
          } catch {
            setPreviewWindowId(null);
            return { ok: false, error: 'Preview window no longer exists.' };
          }
        },
      },
      previewQuery: {
        description: 'Query app protocol state from the preview window',
        params: {
          type: 'object',
          properties: { stateKey: { type: 'string', description: 'State key to query' } },
          required: ['stateKey'],
        },
        handler: async (p: Record<string, unknown>) => {
          const wid = previewWindowId();
          if (!wid) return { ok: false, error: 'No preview window open. Run preview first.' };
          try {
            return await invoke(`yaar://windows/${wid}`, {
              action: 'app_query',
              stateKey: String(p.stateKey),
            });
          } catch {
            return { ok: false, error: 'Preview window not responding.' };
          }
        },
      },
      previewCommand: {
        description: 'Send an app protocol command to the preview window',
        params: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command name' },
            params: { type: 'object', description: 'Command parameters' },
          },
          required: ['command'],
        },
        handler: async (p: Record<string, unknown>) => {
          const wid = previewWindowId();
          if (!wid) return { ok: false, error: 'No preview window open. Run preview first.' };
          try {
            return await invoke(`yaar://windows/${wid}`, {
              action: 'app_command',
              command: String(p.command),
              params: (p.params as Record<string, unknown>) ?? {},
            });
          } catch {
            return { ok: false, error: 'Preview window not responding.' };
          }
        },
      },
      describeUri: {
        description: 'Describe a yaar:// URI — returns supported verbs, description, and invoke schema',
        params: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: 'yaar:// URI to describe (e.g. "yaar://sessions/")' },
          },
          required: ['uri'],
        },
        handler: async (p: Record<string, unknown>) => {
          try {
            return await describe(String(p.uri));
          } catch {
            return { ok: false, error: `Failed to describe URI: ${p.uri}` };
          }
        },
      },
      listUri: {
        description: 'List child resources under a yaar:// URI',
        params: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: 'yaar:// URI to list (e.g. "yaar://sessions/")' },
          },
          required: ['uri'],
        },
        handler: async (p: Record<string, unknown>) => {
          try {
            return await list(String(p.uri));
          } catch {
            return { ok: false, error: `Failed to list URI: ${p.uri}` };
          }
        },
      },
      cloneApp: {
        description: 'Clone an installed app source into a new project',
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App ID to clone' },
          },
          required: ['appId'],
        },
        handler: async (p: Record<string, unknown>) => {
          const projectId = await cloneApp(String(p.appId));
          return { ok: true, projectId };
        },
      },
      clearConsole: {
        description: 'Clear console output',
        params: { type: 'object', properties: {} },
        handler: () => {
          clearConsoleLogs();
          return { ok: true };
        },
      },
    },
  });
}

export {};
import { app, appStorage, invoke, read, describe, list, errMsg } from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';
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
  readFileContent,
  copyFile,
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
          const proj = activeProject();
          if (!proj) return { ok: false, error: 'Project not found' };
          return {
            ok: true,
            project: { id: proj.id, name: proj.name },
            files: files().map((f) => f.path),
          };
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
        description: 'Open a file (or multiple files) in the editor. Use `path` for a single file or `files` array for multiple files.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Single file path' },
            files: { type: 'array', items: { type: 'string' }, description: 'Multiple file paths to open as tabs' },
          },
        },
        handler: async (p: Record<string, unknown>) => {
          const paths: string[] = [];
          if (Array.isArray(p.files)) paths.push(...p.files.map(String));
          if (p.path) paths.push(String(p.path));
          if (paths.length === 0) return { ok: false, error: 'Provide path or files[]' };
          for (const fp of paths) await openFile(fp);
          return { ok: true, opened: paths };
        },
      },
      readFile: {
        description:
          'Read one or more files and return their contents with line numbers. Does NOT change the editor open state. ' +
          'Use `path` (string) for a single file or `path` (array) for multiple files. ' +
          'Optionally specify `startLine` / `endLine` for a line range (1-based, inclusive). ' +
          'Set `openInEditor: true` to also open each file in the editor.',
        params: {
          type: 'object',
          properties: {
            path: {
              oneOf: [
                { type: 'string', description: 'Single file path' },
                { type: 'array', items: { type: 'string' }, description: 'Multiple file paths' },
              ],
            },
            startLine: { type: 'number', description: 'Start line (1-based, inclusive)' },
            endLine: { type: 'number', description: 'End line (1-based, inclusive)' },
            openInEditor: { type: 'boolean', description: 'Also open file(s) in editor UI' },
          },
          required: ['path'],
        },
        handler: async (p: Record<string, unknown>) => {
          const rawPath = p.path;
          const paths: string[] = Array.isArray(rawPath)
            ? rawPath.map(String)
            : [String(rawPath)];
          const opts = {
            startLine: p.startLine != null ? Number(p.startLine) : undefined,
            endLine: p.endLine != null ? Number(p.endLine) : undefined,
          };
          const results = await Promise.all(
            paths.map((fp) => readFileContent(fp, opts)),
          );
          if (p.openInEditor) {
            for (const fp of paths) await openFile(fp);
          }
          if (paths.length === 1) {
            // Single file: return flat result for backwards compat
            const r = results[0];
            return { ok: true, path: r.path, content: r.content, totalLines: r.totalLines };
          }
          // Multiple files: return array + concatenated content
          const combined = results.map((r) => r.content).join('\n\n');
          return { ok: true, files: results, combined };
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
      copyFile: {
        description:
          'Copy a file to another path within the active project. ' +
          'Reads the source and writes it to the destination — destination directories are created automatically. ' +
          'Useful for restructuring (e.g. moving files into a subdirectory) without a separate read+write cycle. ' +
          'Does NOT delete the original; pair with deleteFile to move.',
        params: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source file path (e.g. "src/Foo.ts")' },
            to:   { type: 'string', description: 'Destination file path (e.g. "src/ui/Foo.ts")' },
          },
          required: ['from', 'to'],
        },
        handler: async (p: Record<string, unknown>) => {
          const from = String(p.from);
          const to   = String(p.to);
          if (from === to) return { ok: false, error: 'Source and destination are the same path' };
          try {
            await copyFile(from, to);
            return { ok: true, from, to };
          } catch (err) {
            return { ok: false, error: errMsg(err) };
          }
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
            const appJson = await appStorage.readJsonOr<{ permissions?: string[] } | null>(
              `projects/${proj.id}/app.json`,
              null,
            );
            if (Array.isArray(appJson?.permissions)) permissions = appJson.permissions;
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
            const result = await describe(String(p.uri));
            return { ok: true, result };
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
            const result = await list(String(p.uri));
            return { ok: true, items: result };
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
          const proj = activeProject();
          return {
            ok: true,
            projectId,
            project: proj ? { id: proj.id, name: proj.name } : undefined,
            files: files().map((f) => f.path),
          };
        },
      },
      describeBundledLibrary: {
        description: 'Get detailed type information (methods, interfaces) for a @bundled/* library',
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Library name (e.g. "yaar", "anime", "three")' },
          },
          required: ['name'],
        },
        handler: async (p: Record<string, unknown>) => {
          try {
            const result = await bundledLibraries(String(p.name));
            return { ok: true, ...result };
          } catch (err) {
            return { ok: false, error: errMsg(err) };
          }
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

export {};
import { app, invoke, errMsg } from '@bundled/yaar';
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
  files,
  bundledLibs,
  consoleLogs,
} from './project';
import { projectCommands } from './protocol/projects';
import { fileCommands } from './protocol/files';
import { buildCommands } from './protocol/build';
import { gitCommands } from './protocol/git';
import { previewCommands } from './protocol/preview';
import { introspectCommands } from './protocol/introspect';
import { mediaCommands } from './protocol/media';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'devtools',
    name: 'Devtools',
    state: {
      project: {
        description:
          'Active project. Files come with their size: { path, lines, bytes } for text files, ' +
          '{ path, isDirectory: true } for directories.',
        handler: () => {
          const proj = activeProject();
          if (!proj) return null;
          return {
            ...proj,
            files: files().map((f) =>
              f.isDirectory
                ? { path: f.path, isDirectory: true as const }
                : {
                    path: f.path,
                    ...(f.lines !== undefined ? { lines: f.lines } : {}),
                    ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
                  },
            ),
          };
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
          return {
            path,
            content: `── ${path} (${lines.length} lines) ──\n${numbered}`,
            language: ext,
          };
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
        description:
          'Console output from the preview app, with connection state. `connected: false` means ' +
          'the buffer could not be read — an empty `logs` then says nothing about whether the ' +
          'app logged anything.',
        handler: async () => {
          // Pull the live console buffer straight from the preview window over
          // the app protocol. The preview runs as its own registered window
          // (where verb calls work), so its console-capture buffer is the
          // source of truth — the local signal is only a display cache updated
          // by the poll in project.ts.
          //
          // Every failure here used to collapse into the same empty array, so "no preview open",
          // "preview unreachable" and "app logged nothing" were indistinguishable — a reader had
          // no choice but to guess. Report which one it is.
          const wid = previewWindowId();
          if (!wid) {
            return {
              connected: false,
              reason: 'No preview window is open. Run the preview command first.',
              logs: [],
            };
          }
          try {
            const entries = await invoke(`yaar://windows/${wid}`, {
              action: 'app_query',
              stateKey: '__console',
            });
            if (!Array.isArray(entries)) {
              return {
                connected: false,
                reason: 'Preview window did not return a console buffer.',
                windowId: wid,
                logs: [...consoleLogs()],
              };
            }
            return { connected: true, windowId: wid, logs: entries };
          } catch (err) {
            return {
              connected: false,
              reason: `Preview console unreachable: ${errMsg(err)}`,
              windowId: wid,
              logs: [...consoleLogs()],
            };
          }
        },
      },
    },
    commands: {
      ...projectCommands,
      ...fileCommands,
      ...buildCommands,
      ...gitCommands,
      ...previewCommands,
      ...introspectCommands,
      ...mediaCommands,
    },
  });
}

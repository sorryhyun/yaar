export {};
import { invoke, errMsg } from '@bundled/yaar';
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
} from '../core';

export { projectCommands } from './projects';
export { fileCommands } from './files';
export { buildCommands } from './build';
export { gitCommands } from './git';
export { previewCommands } from './preview';
export { introspectCommands } from './introspect';
export { mediaCommands } from './media';

/**
 * The `defineApp({ state })` map. Split from `main.ts` for the same reason the
 * command maps are split by domain: the protocol extractor resolves imported
 * consts, so the manifest stays whole while the source stays readable.
 */
export const devtoolsState = {
  project: {
    description:
      'Active project. Files come with their size: { path, lines, bytes } for text files, ' +
      '{ path, isDirectory: true } for directories.',
    get: () => {
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
  projectList: {
    description: 'List of all projects (id/name only). Distinct from `project`, the active project with its files.',
    get: () => [...projects()],
  },
  openFile: {
    description: 'Currently open file (with line numbers)',
    get: () => {
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
    get: () => [...diagnostics()],
  },
  compileStatus: {
    description: 'Compilation state',
    get: () => compileStatus(),
  },
  compileErrors: {
    description: 'Compilation errors (if any)',
    get: () => [...compileErrors()],
  },
  previewUrl: {
    description: 'URL of last successful compilation',
    get: () => previewUrl(),
  },
  bundledLibraries: {
    description: 'Available @bundled/* import libraries',
    get: () => [...bundledLibs()],
  },
  consoleLogs: {
    description:
      'Console output from the preview app and Dev Tools evaluation audit entries. ' +
      '`connected: false` means the preview buffer could not be read — an empty `logs` ' +
      'then says nothing about whether the app logged anything.',
    get: async () => {
      // Pull the live console buffer straight from the preview window over
      // the app protocol. The preview runs as its own registered window
      // (where verb calls work), so its console-capture buffer is the
      // source of truth for preview output. The local signal is updated by the
      // poll in project.ts and also retains Dev Tools' evaluation audit entries.
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
        // Evaluations run from Dev Tools rather than inside the preview, so the
        // preview's own console buffer does not contain their input/result audit.
        // Include the local audit entries in both the panel and this state response.
        const evaluations = consoleLogs().filter((entry) => entry.source === 'evaluation');
        const logs = [...entries, ...evaluations]
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-200);
        return { connected: true, windowId: wid, logs };
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
};

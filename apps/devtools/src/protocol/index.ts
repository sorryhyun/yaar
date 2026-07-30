export {};
import { describe, invoke, errMsg } from '@bundled/yaar';
import {
  activeProject,
  projects,
  openFilePath,
  openFileContent,
  diagnostics,
  bundleStatus,
  typecheckState,
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
      'Active project. `lastModified` is the newest write anywhere in it (unix ms, 0 if ' +
      'unknown). Files come with their size — { path, lines, bytes } for text, ' +
      '{ path, bytes } for binary (images, fonts, wasm: real bytes, no line count), ' +
      '{ path, isDirectory: true } for directories. Generated output (dist/) and ' +
      'directories holding nothing are left out. Summing binary `bytes` is how to check ' +
      'an app against the 5MB inlined-asset warning before the compiler raises it.',
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
    description:
      'List of all projects (id/name only). Distinct from `project`, the active project with its files.',
    get: () => [...projects()],
  },
  openFile: {
    description:
      'The file open in the editor UI, with line numbers — what the user is looking at. ' +
      'Not a read tool: `readFile` leaves this alone unless called with openInEditor.',
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
    description:
      'Type errors and warnings from the last typecheck, one entry per diagnostic with ' +
      '{ file, line, message, severity } — paths are project-relative. This is the ' +
      'ONLY place type errors appear; `compileErrors` is the bundler and never repeats them.',
    get: () => [...diagnostics()],
  },
  compileStatus: {
    description:
      'Whether the active project is currently clean. "success" requires BOTH halves: the ' +
      'bundler built AND typecheck ran against the code as it now stands and found no ' +
      'errors. "unchecked" means it bundled but no typecheck covers the current bytes ' +
      '(after a `skipTypecheck` compile, or after any write since the last one) — that is ' +
      'not a pass. "error" means one half failed: read `compileErrors` for the bundler and ' +
      '`diagnostics` for typecheck. Values: idle | compiling | success | unchecked | error.',
    get: () => {
      const bundle = bundleStatus();
      // A bundle that never succeeded decides it on its own: there is nothing to be
      // clean about. Only "it built" leaves the question open for typecheck to answer.
      if (bundle !== 'success') return bundle;
      const checked = typecheckState();
      // Reported as its own value, not folded into either verdict. "It built and nobody
      // type checked it" was the state this key used to call `success`, which is how a
      // project with six live type errors got waved through as clean.
      if (checked === 'unknown') return 'unchecked';
      return checked === 'errors' ? 'error' : 'success';
    },
  },
  compileErrors: {
    description:
      "The BUNDLER's errors from the last compile — unresolved imports, syntax Bun " +
      'cannot parse, a failed plugin. Empty is normal for code full of type errors: Bun ' +
      'strips types and builds through them, so type errors live in `diagnostics` and ' +
      'appear here never. Paths are project-relative, ready to hand back to editFile.',
    get: () => [...compileErrors()],
  },
  previewUrl: {
    description: 'URL of last successful compilation',
    get: () => previewUrl(),
  },
  bundledLibraries: {
    description:
      'Names importable as @bundled/{name}, plus describable pseudo-libraries like ' +
      '"design-tokens" that ship as injected CSS rather than a module. Pass any of them ' +
      'to describeBundledLibrary.',
    get: () => [...bundledLibs()],
  },
  permissions: {
    description:
      'What Dev Tools is allowed to reach: the yaar:// prefixes declared in its app.json, ' +
      'read back from the installed manifest rather than restated here. Read this before ' +
      'assuming a URI is reachable — the alternative is finding out from a 403, which is ' +
      'indistinguishable from the resource not existing. `storage` says which storage root ' +
      'each door writes to; that is the pair most often confused.',
    get: async () => {
      try {
        // `self` is resolved to the real appId by the verb door, so this reports what
        // the *installed* app holds — a permission edited into a sandbox app.json is
        // not in force until it is deployed, and this is where that shows.
        const meta = await describe<{ permissions?: string[]; name?: string }>('yaar://apps/self');
        const declared = Array.isArray(meta?.permissions) ? meta.permissions : [];
        return {
          declared,
          storage: {
            // Two different roots, one word. The agent-side `storage/x` and this app's
            // own appStorage both live under the app; only an explicitly declared
            // prefix reaches the shared tree.
            appScoped: 'yaar://apps/devtools/storage/ — always writable, needs no permission',
            shared: declared.filter((p) => p.startsWith('yaar://storage/')),
            note:
              'A path under the shared root that no declared prefix covers is refused. ' +
              'There is no command here that writes outside these — a report or note ' +
              'belongs in app-scoped storage.',
          },
        };
      } catch (err) {
        // Reported, not swallowed: an empty permission list would read as "allowed
        // nothing", which is a different and much more alarming answer.
        return { error: `Could not read own manifest: ${errMsg(err)}` };
      }
    },
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

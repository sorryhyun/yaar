export {};
import { describe, errMsg } from '@bundled/yaar';
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
  previewIsStale,
  files,
  bundledLibs,
} from '../core';
import {
  workerStatus,
  workerEntries,
  workerActiveTasks,
  workerLastResult,
  workerProposals,
  workerSlots,
  workerCap,
  summarizeProposal,
} from '../services/worker';
import { previewWindowIsOpen } from '../services';
import { resolveCompileStatus } from '../lib';

export { projectCommands } from './projects';
export { fileCommands } from './files';
export { buildCommands } from './build';
export { gitCommands } from './git';
export { previewCommands } from './preview';
export { introspectCommands } from './introspect';
export { httpCommands } from './http';
export { workerCommands } from './worker';
export { testCommands } from './test';
export { audioCommands } from './audio';

/**
 * The `defineApp({ state })` map. Split from `main.ts` for the same reason the
 * command maps are split by domain: the protocol extractor resolves imported
 * consts, so the manifest stays whole while the source stays readable.
 */
export const devtoolsState = {
  project: {
    description:
      'Active project with its whole file tree in `files`: { path, lines, bytes } per text ' +
      'file, { path, bytes } per binary, { path, isDirectory: true } per directory; dist/ and ' +
      'empty directories are left out (`files/list` for those, a glob, or one directory). ' +
      'Null with no project open, and then files/grep and files/delete return empty instead ' +
      'of erroring. Summing binary `bytes` checks the 5MB inlined-asset limit before the ' +
      'compiler warns.',
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
      'Every project as { id, name, lastModified, origin }. Distinct from `project`, the ' +
      'active project with its files. `origin` is "clone:{appId}" for a project/cloneApp sandbox, ' +
      '"new" for a scaffold, and absent for a project created before the marker existed. ' +
      'It is what makes cleanup safe: delete only what you cloned this session, and treat ' +
      'an absent `origin` as the user\'s work — never as "old enough to remove".',
    get: () => [...projects()],
  },
  openFile: {
    description:
      'The file open in the editor UI, with line numbers — what the user is looking at. ' +
      'Not a read tool: `files/read` leaves this alone unless called with openInEditor.',
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
  compileState: {
    description:
      'Whether the active project is currently clean, with the errors behind the verdict: ' +
      '{ status, bundler, typecheck }. `status` is idle | compiling | success | unchecked | ' +
      'error. "success" requires BOTH halves: the bundler built AND typecheck ran against ' +
      'the code as it now stands and found no errors. "unchecked" means it bundled but no ' +
      'typecheck covers the current bytes (after a `skipTypecheck` compile, or after any ' +
      'write since the last one) — that is not a pass. "error" means one half failed. ' +
      "`bundler` is the BUNDLER's errors from the last compile — unresolved imports, syntax " +
      'Bun cannot parse, a failed plugin; empty is normal for code full of type errors, ' +
      'because Bun strips types and builds through them. `typecheck` is the ONLY place type ' +
      'errors appear: one entry per diagnostic from the last typecheck, { file, line, ' +
      'column, code, message, severity }. All paths are project-relative, ready to hand ' +
      'back to files/edit.',
    // The reducer is pure and lives in lib/compile-status.ts, shared with the `build/compile`
    // command so the two cannot drift apart. Its unit checks are the `compile-status`
    // suite in test/self.
    get: () => ({
      status: resolveCompileStatus(bundleStatus(), typecheckState()),
      bundler: [...compileErrors()],
      typecheck: [...diagnostics()],
    }),
  },
  previewOpen: {
    description:
      '{ open, stale, url }. build/manifest and preview/query, command, eval and screenshot ' +
      'fail without an open preview: read this rather than calling `preview/open` ' +
      'defensively, which remounts the iframe and resets in-app state. `stale`: the window ' +
      'shows the previous build (a compile ran with `refreshPreview: false`). `url` is set ' +
      'by compiling and survives the window closing, so it says whether there is anything ' +
      'to show, not whether it is on screen.',
    // Asked of the server, not of our own signal: the user, a project delete or a deploy
    // can close the window without telling us.
    get: async () => {
      const open = await previewWindowIsOpen();
      return { open, stale: open && previewIsStale(), url: previewUrl() };
    },
  },
  bundledLibraries: {
    description:
      'Names importable as @bundled/{name}, plus describable pseudo-libraries like ' +
      '"design-tokens" that ship as injected CSS rather than a module. Pass any of them ' +
      'to inspect/library.',
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
  worker: {
    description:
      "The worker sub-agents (worker/task): `status`, `maxWorkers`, each worker's slot, " +
      '`activeTasks` with the `reports` posted so far, `lastResult`, the transcript tail, and ' +
      '`proposals` — edits waiting on you (worker/readEdit, then worker/acceptEdit or ' +
      'worker/rejectEdit). Never blocks; to wait for a task, call worker/wait instead of ' +
      'polling this.',
    get: () => {
      const entries = workerEntries();
      // Tool lines are one-liners; tasks and answers can be long. Cap per entry so a
      // deep transcript cannot flood a query result.
      const clip = (text: string) =>
        text.length > 4_000 ? `${text.slice(0, 4_000)}… (truncated)` : text;
      const active = workerActiveTasks();
      const last = workerLastResult();
      return {
        status: workerStatus(),
        maxWorkers: workerCap(),
        workers: workerSlots.slice(0, workerCap()).map((s) => ({
          worker: s.id,
          status: s.status(),
          taskId: s.activeTask()?.id ?? null,
        })),
        activeTasks: active.map((t) => ({
          taskId: t.id,
          worker: t.worker,
          task: clip(t.task),
          elapsedMs: Date.now() - t.startedAt,
          ...(t.reports?.length ? { reports: t.reports.map(clip) } : {}),
        })),
        lastResult: last
          ? {
              taskId: last.id,
              worker: last.worker,
              ...(last.answer ? { answer: clip(last.answer) } : {}),
              ...(last.error ? { error: last.error } : {}),
              ...(last.reports?.length ? { reports: last.reports.map(clip) } : {}),
              elapsedMs: (last.endedAt ?? Date.now()) - last.startedAt,
            }
          : null,
        proposals: workerProposals().map(summarizeProposal),
        transcript: entries
          .slice(-30)
          .map((e) => ({ kind: e.kind, worker: e.worker, text: clip(e.text) })),
      };
    },
  },
};

export {};
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
      'Active project and its file tree. `files` has { path, lines, bytes } per text file, ' +
      '{ path, bytes } per binary, { path, isDirectory: true } per directory; dist/ and empty ' +
      'directories are left out (files/list shows those). Null with no project open. Summing ' +
      'binary `bytes` checks the 5MB inlined-asset limit before the compiler warns.',
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
      'Every project as { id, name, lastModified, origin }. `origin` is "clone:{appId}" for a ' +
      'project/cloneApp sandbox, "new" for a scaffold, absent for an older project. Delete ' +
      'only what you cloned this session; treat an absent `origin` as the user\'s work.',
    get: () => [...projects()],
  },
  openFile: {
    description:
      'The file the user has open in the editor UI, with line numbers.',
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
      'Whether the active project is clean: { status, bundler, typecheck }. `status`: idle | ' +
      'compiling | success (bundled and typechecked as it stands) | unchecked (bundled, but no ' +
      'typecheck covers the current bytes — not a pass) | error. `bundler` and `typecheck` ' +
      'list the last run of each (build/compile explains the split); paths are project-relative.',
    // The reducer is pure and lives in lib/compile-status.ts, shared with the `build/compile`
    // command so the two cannot drift apart. Its unit checks are the `compile-status`
    // suite (src/test/lib-suites.ts).
    get: () => ({
      status: resolveCompileStatus(bundleStatus(), typecheckState()),
      bundler: [...compileErrors()],
      typecheck: [...diagnostics()],
    }),
  },
  previewOpen: {
    description:
      'Whether a preview is open, stale, and its URL: { open, stale, url }. The preview/* ' +
      'probes fail without an open preview — read this rather than calling preview/open ' +
      'defensively. `stale`: the window shows the previous build (`refreshPreview: false`). ' +
      '`url` survives the window closing: it says there is a build to show, not that it is on screen.',
    // Asked of the server, not of our own signal: the user, a project delete or a deploy
    // can close the window without telling us.
    get: async () => {
      const open = await previewWindowIsOpen();
      return { open, stale: open && previewIsStale(), url: previewUrl() };
    },
  },
  worker: {
    description:
      'Worker sub-agent status, active tasks, and pending edit `proposals`. Never blocks; ' +
      'worker/wait does.',
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

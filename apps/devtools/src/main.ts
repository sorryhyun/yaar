import { defineApp } from '@bundled/yaar';
import './styles/index';
import { AppShell } from './app-shell';
import {
  loadProjects,
  restoreWorkspace,
  loadBundledLibraries,
  loadWorkerConfig,
  startConsolePolling,
} from './services';
import {
  devtoolsState,
  projectCommands,
  fileCommands,
  buildCommands,
  gitCommands,
  previewCommands,
  introspectCommands,
  httpCommands,
  workerCommands,
  testCommands,
} from './protocol/index';

// Registers the protocol and mounts `AppShell` into the compiler's `#app`.
// The descriptor maps stay split by domain — the protocol extractor resolves
// imported consts and spreads, so every command reaches `dist/protocol.json`
// (a count here would be one map away from being wrong; read the manifest).
export default defineApp({
  id: 'devtools',
  name: 'Devtools',
  // Nothing this app does is replayed on a remount.
  //
  // Replay exists to rebuild a document that lost its state. This one does not lose it:
  // the projects are in storage, and which of them were open is in `workspace.json`,
  // which `restoreWorkspace` reads at startup. So replay restores nothing here — it only
  // re-runs the turn's history against a sandbox that has since moved on. Every clone and
  // every `createProject` mints its id from `Date.now()`, so a remount made a *second*
  // copy of the project being worked on; every `editFile` re-applied its insertion on top
  // of the text that already had it; every `deploy` shipped again. And because the server
  // sends the whole log at once, the handlers interleaved: a phone coming back from the
  // background showed one project's file tree over another project's editor, under a
  // status line naming a third.
  //
  // The per-command `replay: 'never'` in protocol/worker.ts stay as they are: they are
  // true of those commands on their own terms, and they should keep holding if this
  // app-wide default is ever narrowed.
  replay: 'never',
  events: {
    worker: {
      description:
        'Worker sub-agent progress; every payload names its `worker` (several run in ' +
        'parallel). Two shapes, told apart by `kind`: "result" — the task ' +
        'settled, { kind, taskId, worker, task, answer?, error?, reports?, elapsedMs }, exactly one ' +
        'of answer/error always present; and "report" — an interim finding posted mid-task, ' +
        '{ kind, taskId, worker, task, report, reportIndex, elapsedMs }, which means the task is ' +
        'STILL RUNNING. Emitted with wakeAgent for a task the app agent started (so it can ' +
        'end its turn and be woken) and without it for one the user ran from the Worker ' +
        'panel, which nobody is waiting on; a report additionally wakes only when the worker ' +
        'marked it urgent.',
    },
  },
  state: devtoolsState,
  commands: {
    ...projectCommands,
    ...fileCommands,
    ...buildCommands,
    ...gitCommands,
    ...previewCommands,
    ...introspectCommands,
    ...httpCommands,
    ...workerCommands,
    ...testCommands,
  },
  view: AppShell,
});

// Sequenced, not fired in parallel: the restore filters the stored tabs against the
// project list, so it has to run after that list is in. Everything below is independent.
loadProjects().then(restoreWorkspace);
loadBundledLibraries();
loadWorkerConfig();
startConsolePolling();

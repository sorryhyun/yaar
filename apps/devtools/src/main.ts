import { defineApp } from '@bundled/yaar';
import './styles/index';
import { AppShell } from './app-shell';
import { loadProjects, loadBundledLibraries, startConsolePolling } from './services';
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
} from './protocol/index';

// Registers the protocol and mounts `AppShell` into the compiler's `#app`.
// The descriptor maps stay split by domain — the protocol extractor resolves
// imported consts and spreads, so every command reaches `dist/protocol.json`
// (a count here would be one map away from being wrong; read the manifest).
export default defineApp({
  id: 'devtools',
  name: 'Devtools',
  events: {
    worker: {
      description:
        'Worker sub-agent progress. Two shapes, told apart by `kind`: "result" — the task ' +
        'settled, { kind, taskId, task, answer?, error?, reports?, elapsedMs }, exactly one ' +
        'of answer/error always present; and "report" — an interim finding posted mid-task, ' +
        '{ kind, taskId, task, report, reportIndex, elapsedMs }, which means the task is ' +
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
  },
  view: AppShell,
});

loadProjects();
loadBundledLibraries();
startConsolePolling();

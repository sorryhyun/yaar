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
        'A worker sub-agent task settled. Payload: { taskId, answer?, error?, elapsedMs }. ' +
        'Emitted with wakeAgent for a task the app agent started (so it can end its turn ' +
        'and be woken by the answer) and without it for one the user ran from the Worker ' +
        'panel, which nobody is waiting on.',
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

// ── Init ──

loadProjects();
loadBundledLibraries();
startConsolePolling();

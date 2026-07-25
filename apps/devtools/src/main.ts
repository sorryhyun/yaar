import { defineApp } from '@bundled/yaar';
import './styles.css';
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
  mediaCommands,
} from './protocol/index';

// Registers the protocol and mounts `AppShell` into the compiler's `#app`.
// The descriptor maps stay split by domain — the protocol extractor resolves
// imported consts and spreads, so all 28 commands reach `dist/protocol.json`.
export default defineApp({
  id: 'devtools',
  name: 'Devtools',
  state: devtoolsState,
  commands: {
    ...projectCommands,
    ...fileCommands,
    ...buildCommands,
    ...gitCommands,
    ...previewCommands,
    ...introspectCommands,
    ...mediaCommands,
  },
  view: AppShell,
});

// ── Init ──

loadProjects();
loadBundledLibraries();
startConsolePolling();

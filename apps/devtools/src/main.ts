export {};
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { AppShell } from './app-shell';
import {
  loadProjects,
  loadBundledLibraries,
  startConsolePolling,
} from './project';
import { registerProtocol } from './protocol';

render(AppShell, document.getElementById('app')!);

// ── Init ──

registerProtocol();
loadProjects();
loadBundledLibraries();
startConsolePolling();

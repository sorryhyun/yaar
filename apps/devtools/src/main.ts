export {};
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { AppShell } from './app-shell';
import { loadProjects, loadBundledLibraries, startConsolePolling } from './services';
import { registerProtocol } from './protocol/index';

render(AppShell, document.getElementById('app')!);

// ── Init ──

registerProtocol();
loadProjects();
loadBundledLibraries();
startConsolePolling();

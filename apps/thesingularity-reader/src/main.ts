import { onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { state } from './store';
import { doRefresh, startRefreshTimer, clearTimers, initLoginStatus } from './actions';
import { loadCredentials } from './credentials';
import { setState } from './store';
import { registerProtocol } from './protocol';
import { Header } from './ui/Header';
import { SettingsPanel } from './ui/SettingsPanel';
import { LoginPanel } from './ui/LoginPanel';
import { RecommendPanel } from './ui/RecommendPanel';
import { PostList } from './ui/PostList';
import { DetailPanel } from './ui/DetailPanel';

function App() {
  onMount(async () => {
    registerProtocol();

    const creds = await loadCredentials();
    if (creds) {
      setState('savedCredentials', creds);
    }

    initLoginStatus().catch(() => {});

    await doRefresh();
    startRefreshTimer();
  });

  onCleanup(() => {
    clearTimers();
  });

  return html`
    <div class="y-app">
      <${Header} />
      ${() => (state.showSettings ? html`<${SettingsPanel} />` : null)}
      ${() => (state.showLogin ? html`<${LoginPanel} />` : null)}
      ${() => (state.showRec ? html`<${RecommendPanel} />` : null)}
      <div class="main-layout">
        <${PostList} />
        <${DetailPanel} />
      </div>
    </div>
  `;
}

render(() => html`<${App} />`, document.getElementById('app')!);

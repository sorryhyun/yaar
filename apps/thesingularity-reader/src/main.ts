import { onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { showSettings, showRec } from './store';
import { doRefresh, startRefreshTimer, clearTimers } from './actions';
import { loadSettings } from './store';
import { registerProtocol } from './protocol';
import { Header } from './Header';
import { SettingsPanel } from './SettingsPanel';
import { RecommendPanel } from './RecommendPanel';
import { PostList } from './PostList';
import { DetailPanel } from './DetailPanel';

function App() {
  onMount(async () => {
    registerProtocol();
    await loadSettings();
    await doRefresh();
    startRefreshTimer();
  });

  onCleanup(() => {
    clearTimers();
  });

  return html`
    <div class="y-app">
      <${Header} />
      ${() => (showSettings() ? html`<${SettingsPanel} />` : null)}
      ${() => (showRec() ? html`<${RecommendPanel} />` : null)}
      <div class="main-layout">
        <${PostList} />
        <${DetailPanel} />
      </div>
    </div>
  `;
}

render(() => html`<${App} />`, document.getElementById('app')!);

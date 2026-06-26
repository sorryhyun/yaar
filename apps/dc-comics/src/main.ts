import { onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { doRefresh, loadSubs, startRefreshTimer, clearTimers } from './actions';
import { registerProtocol } from './protocol';
import { Header } from './ui/Header';
import { PostList } from './ui/PostList';
import { DetailPanel } from './ui/DetailPanel';
import { SubscriptionPanel } from './ui/SubscriptionPanel';
import { SettingsPanel } from './ui/SettingsPanel';
import { closeTab, MAIN_TAB, POST_TAB } from './browser';
import { state } from './store';

function App() {
  onMount(async () => {
    registerProtocol();
    await loadSubs();
    await doRefresh();
    startRefreshTimer();
  });

  onCleanup(() => {
    clearTimers();
    closeTab(MAIN_TAB);
    closeTab(POST_TAB);
  });

  return html`
    <div id="app-root">
      <${Header} />
      ${() => (state.showSettings ? html`<${SettingsPanel} />` : null)}
      <div class="main-layout">
        ${() =>
          state.activePanel === 'subscriptions'
            ? html`<${SubscriptionPanel} />`
            : html`
                <${PostList} />
                <${DetailPanel} />
              `}
      </div>
    </div>
  `;
}

render(() => html`<${App} />`, document.getElementById('app')!);

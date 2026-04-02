import { onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { doRefresh, loadSubs, refreshAllSubs } from './actions';
import { Header } from './ui/Header';
import { PostList } from './ui/PostList';
import { DetailPanel } from './ui/DetailPanel';
import { SubscriptionPanel } from './ui/SubscriptionPanel';
import { closeTab } from './browser';
import { MAIN_TAB, POST_TAB } from './browser';
import { state } from './store';

function App() {
  onMount(() => {
    doRefresh();
    loadSubs();
    const interval = setInterval(() => refreshAllSubs(), 5 * 60 * 1000);
    onCleanup(() => clearInterval(interval));
  });

  onCleanup(() => {
    closeTab(MAIN_TAB);
    closeTab(POST_TAB);
  });

  return html`
    <div id="app-root">
      <${Header} />
      <div class="main-layout">
        ${() => state.activePanel === 'subscriptions'
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

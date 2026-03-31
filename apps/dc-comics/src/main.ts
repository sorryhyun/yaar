import { onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { doRefresh } from './actions';
import { Header } from './ui/Header';
import { PostList } from './ui/PostList';
import { DetailPanel } from './ui/DetailPanel';
import { closeTab } from './browser';
import { MAIN_TAB, POST_TAB } from './browser';

function App() {
  onMount(() => {
    doRefresh();
  });

  onCleanup(() => {
    closeTab(MAIN_TAB);
    closeTab(POST_TAB);
  });

  return html`
    <div id="app-root">
      <${Header} />
      <div class="main-layout">
        <${PostList} />
        <${DetailPanel} />
      </div>
    </div>
  `;
}

render(() => html`<${App} />`, document.getElementById('app')!);

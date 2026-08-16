import html from '@bundled/solid-js/html';
import { appGrid } from './app-grid.js';
import { githubBanner } from './banner.js';
import { headerBar } from './header.js';
import { publishModal } from './publish-dialog.js';
import { searchBar } from './search-bar.js';

/**
 * The whole view, in the order it stacks: the GitHub warning strip, the publish
 * dialog (both render nothing until they have something to say), then the three
 * bands of the page. `.y-app` is a flex column; `.list-grid` is the one that grows.
 */
export function App() {
  return html`
    <div class="y-app">
      ${githubBanner()} ${publishModal()} ${headerBar()} ${searchBar()} ${appGrid()}
    </div>
  `;
}
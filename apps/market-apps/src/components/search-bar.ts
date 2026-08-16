import html from '@bundled/solid-js/html';
import {
  displayApps,
  hideInstalled,
  installedApps,
  search,
  searchMode,
  setSearch,
  setSearchMode,
  visibleApps,
} from '../store/index.js';
import type { SearchMode } from '../store/index.js';
import { targetValue } from './ui.js';

/**
 * What the box asks for in each mode. A lookup rather than a ternary chain so a
 * new mode is one entry here and the compiler names this file if it is missed.
 */
const SEARCH_PLACEHOLDERS: Record<SearchMode, string> = {
  title: 'Search apps by name or description…',
  author: 'Search apps by author…',
  official: 'Filter YAAR official apps…',
};

/**
 * The count on the right: how many cards are showing, out of how many exist, and
 * how many are installed. It only says "N of M" while something is actually
 * filtering — otherwise the two numbers are the same and the comparison is noise.
 */
function filterCount(): string {
  const total = displayApps().length;
  const visible = visibleApps().length;
  const installed = installedApps().length;
  if (!total) return 'No apps loaded';
  const filtered = hideInstalled() || !!search().trim();
  return filtered
    ? `${visible} of ${total} apps • ${installed} installed`
    : `${total} apps • ${installed} installed`;
}

/**
 * Search-mode dropdown + query box + result count.
 *
 * The `<option>` elements are written out statically rather than mapped from
 * SEARCH_MODES: Solid applies the select's `value` as it builds the element, so
 * options arriving through an interpolation would not exist yet and the box would
 * start blank.
 */
export function searchBar() {
  return html`
    <div class="search-bar y-surface">
      <select
        class="y-select search-mode-select"
        aria-label="Search field"
        value=${() => searchMode()}
        onChange=${(e: Event) => setSearchMode(targetValue(e) as SearchMode)}
      >
        <option value="title">Title</option>
        <option value="author">Author</option>
        <option value="official">YAAR Official</option>
      </select>
      <input
        class="y-input search-input"
        type="search"
        placeholder=${() => SEARCH_PLACEHOLDERS[searchMode()]}
        aria-label="Search apps"
        value=${() => search()}
        onInput=${(e: Event) => setSearch(targetValue(e))}
      />
      <span class="filter-count y-text-muted">${() => filterCount()}</span>
    </div>
  `;
}
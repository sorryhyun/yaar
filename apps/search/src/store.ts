export {};
import { createStore } from '@bundled/solid-js/store';
import { createSharedSignal } from '@bundled/yaar';
import type { SearchMatch, DepsGraph } from './types';

export const [state, setState] = createStore({
  query: '',
  glob: '',
  scope: '',
  /** The scope the CURRENT results were actually fetched with (may differ from the UI's `scope`). */
  resultScope: '',
  matches: [] as SearchMatch[],
  /** Search generated output too. Off by default; the toolbar toggle and the `includeBuilt` param both set it. */
  includeBuilt: false,
  truncated: false,
  /** Matches the last search dropped as generated output. Only meaningful when includeBuilt is false. */
  excluded: 0,
  searching: false,
  selectedIndex: null as number | null,
  previewPath: null as string | null,
  previewContent: null as string | null,
  previewHighlightLine: null as number | null,
  showCloneDialog: false,
  cloneAppId: '',
  cloneDestPath: '',
  statusText: 'Ready',
  /** ── Dependency diagram (analyze-deps mode: "mermaid") ──────────────── */
  depsGraph: null as DepsGraph | null,
  /** Rendered SVG for depsGraph.mermaid, or null while rendering / on failure. */
  depsSvg: null as string | null,
  depsError: null as string | null,
  depsRendering: false,
  depsShowSource: false,
  depsZoom: 1,
  depsSelectedFile: null as string | null,
});

const remoteSearchListeners: ((next: SharedSearchResult) => void)[] = [];
const remoteSelectionListeners: ((index: number | null) => void)[] = [];

/** What a completed search renders: the query bar, the match list, and its stats. */
export interface SharedSearchResult {
  query: string;
  glob: string;
  scope: string;
  resultScope: string;
  matches: SearchMatch[];
  includeBuilt: boolean;
  truncated: boolean;
  excluded: number;
  statusText: string;
}

/**
 * The last completed search, shared across copies of this window: the `search`
 * command runs in whichever copy the server picked to answer, so without this the
 * phone would keep showing stale results while the agent's copy filled in. Written
 * once, at the end of `performSearch` — never from `onRemote`, which would ping-pong
 * the write back to the copy that just sent it.
 */
export const [sharedSearch, setSharedSearch] = createSharedSignal<SharedSearchResult | null>(
  'search',
  null,
  { onRemote: (next) => next && remoteSearchListeners.forEach((fn) => fn(next)) },
);

/** Run `fn` when another copy of this window completes a search. */
export function onRemoteSearch(fn: (next: SharedSearchResult) => void): void {
  remoteSearchListeners.push(fn);
}

/**
 * Which result is selected, shared the same way. Only the index travels — the
 * matches themselves already arrive via `sharedSearch`, and the previewed file's
 * content is one cheap read away, so carrying it too would just risk the 8 MB cap
 * on a large source file.
 */
export const [sharedSelection, setSharedSelection] = createSharedSignal<number | null>(
  'selection',
  null,
  { onRemote: (index) => remoteSelectionListeners.forEach((fn) => fn(index)) },
);

/** Run `fn` when another copy of this window selects (or clears) a result. */
export function onRemoteSelection(fn: (index: number | null) => void): void {
  remoteSelectionListeners.push(fn);
}

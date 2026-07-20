export {};
import { createStore } from '@bundled/solid-js/store';
import type { SearchMatch } from './types';

export const [state, setState] = createStore({
  query: '',
  glob: '',
  scope: '',
  /** The scope the CURRENT results were actually fetched with (may differ from the UI's `scope`). */
  resultScope: '',
  matches: [] as SearchMatch[],
  truncated: false,
  searching: false,
  selectedIndex: null as number | null,
  previewPath: null as string | null,
  previewContent: null as string | null,
  previewHighlightLine: null as number | null,
  showCloneDialog: false,
  cloneAppId: '',
  cloneDestPath: '',
  statusText: 'Ready',
});

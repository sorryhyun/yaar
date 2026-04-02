import { createStore } from '@bundled/solid-js/store';
import type { SessionSummary, SessionDetail, ParsedMessage } from './types';

export const [state, setState] = createStore({
  sessions: [] as SessionSummary[],
  currentSessionId: '',
  selectedId: null as string | null,
  detail: null as SessionDetail | null,
  transcript: null as string | null,
  messages: null as ParsedMessage[] | null,
  loading: false,
  detailLoading: false,
  search: '',
  totalCount: 0,
  loadError: null as string | null,
});

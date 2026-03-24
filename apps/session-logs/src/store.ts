import { createStore } from '@bundled/solid-js/store';
import type { SessionSummary, SessionDetail } from './types';

export const [state, setState] = createStore({
  sessions: [] as SessionSummary[],
  currentSessionId: '',
  selectedId: null as string | null,
  detail: null as SessionDetail | null,
  loading: false,
  detailLoading: false,
  search: '',
  totalCount: 0,
  loadError: null as string | null,
});

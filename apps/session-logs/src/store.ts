import { createStore } from '@bundled/solid-js/store';
import { createSharedSignal } from '@bundled/yaar';
import type { SessionSummary, SessionDetail, ParsedMessage } from './types';

export const [state, setState] = createStore({
  sessions: [] as SessionSummary[],
  currentSessionId: '',
  selectedId: null as string | null,
  detail: null as SessionDetail | null,
  transcript: null as string | null,
  messages: null as ParsedMessage[] | null,
  messagesError: null as string | null,
  loading: false,
  detailLoading: false,
  search: '',
  totalCount: 0,
  loadError: null as string | null,
});

const remoteSessionsListeners: ((next: SharedSessionList) => void)[] = [];
const remoteSelectedSessionListeners: ((sessionId: string) => void)[] = [];

export interface SharedSessionList {
  sessions: SessionSummary[];
  currentSessionId: string;
  totalCount: number;
}

/**
 * The session list, shared across copies of this window: `refresh` (and the initial
 * load) runs in whichever copy the server picked to answer, so without this the
 * other copy would keep showing whatever it last fetched on its own. Summaries only
 * (id, provider, dates, counts) — small enough to send as data rather than a pointer
 * a follower would have to re-fetch.
 */
export const [sharedSessions, setSharedSessions] = createSharedSignal<SharedSessionList | null>(
  'sessions',
  null,
  { onRemote: (next) => next && remoteSessionsListeners.forEach((fn) => fn(next)) },
);

/** Run `fn` when another copy of this window reloads the session list. */
export function onRemoteSessions(fn: (next: SharedSessionList) => void): void {
  remoteSessionsListeners.push(fn);
}

/**
 * Which session is selected, shared as a pointer only: the transcript and message
 * log behind it can run to megabytes, well past the shared signal's 8 MB cap, so a
 * follower re-fetches them itself (`loadDetail`) rather than receiving them over
 * the wire.
 */
export const [sharedSelectedSession, setSharedSelectedSession] = createSharedSignal<string | null>(
  'selected-session',
  null,
  { onRemote: (id) => id && remoteSelectedSessionListeners.forEach((fn) => fn(id)) },
);

/** Run `fn` when another copy of this window selects a session. */
export function onRemoteSelectedSession(fn: (sessionId: string) => void): void {
  remoteSelectedSessionListeners.push(fn);
}

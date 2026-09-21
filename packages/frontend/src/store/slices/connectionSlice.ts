/**
 * Connection slice - manages WebSocket connection state.
 */
import { readJoinSessionId } from '@/lib/joinSession';
import type { SliceCreator } from '../types';
import type { RecoveryMode } from '@yaar/shared';
import type { ConnectionStatus } from '@/types/state';

export interface ConnectionSliceState {
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  providerType: string | null;
  sessionId: string | null;
  /** Incarnation of `sessionId` this connection is bound to. Null until attached. */
  sessionEpoch: number | null;
  /** This tab's connection id on the server. Null until attached. */
  connectionId: string | null;
  /** What the server did with the session id we asked for. Null until attached. */
  recoveryMode: RecoveryMode | null;
}

export interface ConnectionSliceActions {
  setConnectionStatus: (status: ConnectionStatus, error?: string) => void;
  /** Set the last error text without asserting anything about the transport. */
  setConnectionError: (error: string | null) => void;
  setSession: (providerType: string, sessionId: string) => void;
  setAttachment: (attachment: {
    sessionId: string;
    sessionEpoch: number;
    connectionId: string;
    recoveryMode: RecoveryMode;
    provider?: string;
  }) => void;
}

export type ConnectionSlice = ConnectionSliceState & ConnectionSliceActions;

export const createConnectionSlice: SliceCreator<ConnectionSlice> = (set, _get) => ({
  connectionStatus: 'disconnected' as ConnectionStatus,
  connectionError: null,
  providerType: null,
  // Null in the ordinary case, so the socket opens without an id and the server mints a
  // session. Non-null only for `?sessionId=`, where this document is joining a session that
  // already exists — see lib/joinSession.ts.
  sessionId: readJoinSessionId(),
  sessionEpoch: null,
  connectionId: null,
  recoveryMode: null,

  setConnectionStatus: (status, error) =>
    set((state) => {
      state.connectionStatus = status;
      state.connectionError = error ?? null;
    }),

  // Record something that went wrong without claiming the transport did.
  //
  // A ServerEvent ERROR is almost never about the connection: it names a message that
  // was dropped, an app agent that threw, a queue that was full. Routing those through
  // setConnectionStatus('error') put the whole desktop into a state the status bar
  // renders as "Disconnected" — while the socket was open and the agent kept working,
  // with nothing to clear it until the next attach. The text is still worth keeping:
  // it is what the stalled LoadingScreen shows when the *first* connection is the thing
  // that failed ("No AI provider available. Install Claude CLI.").
  setConnectionError: (error) =>
    set((state) => {
      state.connectionError = error;
    }),

  setSession: (providerType, sessionId) =>
    set((state) => {
      state.providerType = providerType;
      state.sessionId = sessionId;
    }),

  // The server bound this socket to a session incarnation. `sessionEpoch` and
  // `recoveryMode` are what separate rejoining the session we left from being handed a new
  // one wearing the same id: a changed epoch means whatever local state we still hold for
  // this sessionId describes a session that no longer exists.
  setAttachment: (attachment) =>
    set((state) => {
      state.sessionId = attachment.sessionId;
      state.sessionEpoch = attachment.sessionEpoch;
      state.connectionId = attachment.connectionId;
      state.recoveryMode = attachment.recoveryMode;
      if (attachment.provider) state.providerType = attachment.provider;
      state.connectionStatus = 'connected';
      state.connectionError = null;
    }),
});

/**
 * Connection slice - manages WebSocket connection state.
 */
import type { SliceCreator, ConnectionSlice, ConnectionStatus } from '../types';

export const createConnectionSlice: SliceCreator<ConnectionSlice> = (set, _get) => ({
  connectionStatus: 'disconnected' as ConnectionStatus,
  connectionError: null,
  providerType: null,
  sessionId: null,
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

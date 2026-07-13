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

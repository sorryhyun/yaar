import { del, invoke, read } from '@bundled/yaar';

export const REMOTE_CONTROL_URI = 'yaar://system/remote-control';

/** `status()` in the server's handlers/remote-control.ts. */
export interface RemoteControlStatus {
  running: boolean;
  state: 'ready' | null;
  /** The monitor whose agent is on claude.ai. */
  monitorId: string | null;
  sessionUrl: string | null;
  name: string | null;
  /** The monitor of whoever read this — for the app, its own window's. Absent on `start`. */
  callerMonitorId?: string | null;
}

export interface StartOptions {
  name?: string;
}

export function fetchStatus(): Promise<RemoteControlStatus> {
  return read<RemoteControlStatus>(REMOTE_CONTROL_URI);
}

/** Resolves after the user answers the permission dialog and the conversation is on claude.ai. */
export function startRemote(opts: StartOptions): Promise<RemoteControlStatus> {
  return invoke<RemoteControlStatus>(REMOTE_CONTROL_URI, { action: 'start', ...opts });
}

export async function stopRemote(): Promise<void> {
  await del(REMOTE_CONTROL_URI);
}

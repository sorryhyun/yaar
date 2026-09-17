import { del, invoke, read } from '@bundled/yaar';

export const REMOTE_CONTROL_URI = 'yaar://system/remote-control';

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
  'plan',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** `RemoteControlStatus` in the server's features/remote-control/host.ts. */
export interface RemoteControlStatus {
  running: boolean;
  state: 'starting' | 'ready' | 'exited' | null;
  pid: number | null;
  monitorId: string | null;
  startedAt: string | null;
  sessionUrl: string | null;
  exitCode: number | null;
  tail: string;
  /** The monitor of whoever read this — for the app, its own window's. Absent on `start`. */
  callerMonitorId?: string | null;
}

export interface StartOptions {
  name?: string;
  permissionMode?: PermissionMode;
  continue?: boolean;
}

export function fetchStatus(): Promise<RemoteControlStatus> {
  return read<RemoteControlStatus>(REMOTE_CONTROL_URI);
}

/** Resolves after the user answers the permission dialog and the process is spawned. */
export function startHost(opts: StartOptions): Promise<RemoteControlStatus> {
  return invoke<RemoteControlStatus>(REMOTE_CONTROL_URI, { action: 'start', ...opts });
}

export async function writeHost(data: string): Promise<void> {
  await invoke(REMOTE_CONTROL_URI, { action: 'write', data });
}

export async function stopHost(): Promise<void> {
  await del(REMOTE_CONTROL_URI);
}

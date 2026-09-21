// YAAR's own REST routes (http/routes/remote-control.ts); there is no `yaar://` verb. The fetch
// proxy attaches this window's iframe token, which is how the server learns the monitor, and
// the routes answer only the bundled Remote Control app.
const BASE = '/api/remote-control';

/** `remoteControlStatus()` in the server's features/remote-control.ts. */
export interface RemoteControlStatus {
  running: boolean;
  state: 'ready' | null;
  /** The monitor whose agent is on claude.ai. */
  monitorId: string | null;
  sessionUrl: string | null;
  name: string | null;
  /** This window's own monitor. */
  callerMonitorId: string | null;
}

export interface StartOptions {
  name?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init);
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `${init?.method ?? 'GET'} ${path} → ${res.status}`);
  return body as T;
}

export function fetchStatus(): Promise<RemoteControlStatus> {
  return call<RemoteControlStatus>('');
}

/** Resolves after the user answers the permission dialog and the conversation is on claude.ai. */
export function startRemote(opts: StartOptions): Promise<RemoteControlStatus> {
  return call<RemoteControlStatus>('/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export async function stopRemote(): Promise<void> {
  await call('/stop', { method: 'POST' });
}

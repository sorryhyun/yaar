import { showToast } from '@bundled/yaar';
import {
  fetchStatus,
  startRemote,
  stopRemote,
  type RemoteControlStatus,
  type StartOptions,
} from './gateway';
import { busy, running, sessionName, setBusy, setLastError, setStatus } from './store';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function refreshStatus(): Promise<RemoteControlStatus | null> {
  try {
    const next = await fetchStatus();
    setStatus(next);
    return next;
  } catch (err) {
    setLastError(message(err));
    return null;
  }
}

/** Throws, so a protocol caller hears about a denial or a refusal. */
export async function start(opts: StartOptions): Promise<RemoteControlStatus> {
  setBusy(true);
  setLastError('');
  try {
    const started = await startRemote(opts);
    // `start`'s status carries no `callerMonitorId`; a read does.
    return (await refreshStatus()) ?? started;
  } finally {
    setBusy(false);
  }
}

export async function stop(): Promise<void> {
  setBusy(true);
  setLastError('');
  try {
    await stopRemote();
    await refreshStatus();
  } finally {
    setBusy(false);
  }
}

/** The switch in the UI: reports its own failure instead of throwing. */
export async function toggle(): Promise<void> {
  if (busy()) return;
  try {
    if (running()) {
      await stop();
    } else {
      const opts: StartOptions = {};
      const name = sessionName().trim();
      if (name) opts.name = name;
      await start(opts);
    }
  } catch (err) {
    setLastError(message(err));
  }
}

export async function copyLink(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied', 'success');
  } catch (err) {
    showToast(`Copy failed: ${message(err)}`, 'error');
  }
}

/**
 * A real browser tab, not a YAAR window: claude.ai refuses framing, and the Browser app's
 * sandbox profile is not signed in to the user's account.
 */
export function openLink(url: string): void {
  const w = window as Window & { __yaarAllowPopups?: boolean };
  w.__yaarAllowPopups = true;
  try {
    // No `noopener` feature: with it `open` returns null even on success.
    const tab = window.open(url, '_blank');
    if (tab) tab.opener = null;
    else void copyLink(url);
  } finally {
    w.__yaarAllowPopups = false;
  }
}

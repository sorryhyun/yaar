/**
 * App Protocol state observed at app-agent handoff boundaries.
 *
 * The app remains authoritative. We retain only a stable fingerprint of the combined
 * declared state, enough to tell the next invocation whether anything changed while the
 * agent was released without copying app data into the model prompt.
 */

import { createHash } from 'crypto';

/** Canonical JSON keeps object insertion order from looking like a state change. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return '"__yaar_undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

/** One aggregate fingerprint across every state key declared by the app protocol. */
export function fingerprintAppState(state: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

export function formatAppStateHandoffNotice(changed: boolean): string {
  return `<app_state_since_handoff changed="${changed}" />`;
}

export class AppStateHandoffStore {
  private readonly fingerprints = new Map<string, string>();

  has(windowId: string): boolean {
    return this.fingerprints.has(windowId);
  }

  changedSinceHandoff(windowId: string, state: Record<string, unknown>): boolean | undefined {
    const previous = this.fingerprints.get(windowId);
    if (previous === undefined) return undefined;
    return previous !== fingerprintAppState(state);
  }

  remember(windowId: string, state: Record<string, unknown>): void {
    this.fingerprints.set(windowId, fingerprintAppState(state));
  }

  forget(windowId: string): void {
    this.fingerprints.delete(windowId);
  }

  forgetMonitor(monitorId: string): void {
    const prefix = `${monitorId}/`;
    for (const windowId of this.fingerprints.keys()) {
      if (windowId.startsWith(prefix)) this.fingerprints.delete(windowId);
    }
  }

  clear(): void {
    this.fingerprints.clear();
  }
}

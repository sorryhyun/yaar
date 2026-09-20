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

/** The reclamations a successor agent is owed a sentence about. */
export type ContextLostReason = 'idle' | 'external';

const WHY: Record<ContextLostReason, string> = {
  idle: 'it was reclaimed after going quiet, which on a phone or a backgrounded browser tab happens without anyone deciding to',
  external: 'it was deleted',
};

/**
 * The one thing a replacement app agent cannot find out for itself: that there *was* a
 * predecessor, and that its memory is gone.
 *
 * Unlike {@link formatAppStateHandoffNotice}, this is prose rather than a bare tag,
 * because it fires only after an involuntary reclamation and has to be legible to an
 * agent whose prompt never mentioned it. The instruction is the point: an agent that
 * believes it is starting clean re-does work that already landed — the reported case was
 * three clones of one app, each made by a successor that had no idea the first two
 * existed.
 */
export function formatContextLostNotice(reason: ContextLostReason): string {
  return (
    `<prior_agent_context_lost reason="${reason}">\n` +
    `An earlier agent was driving this app and its memory has ended — ${WHY[reason]}. ` +
    'You are its replacement and remember nothing it did, including work it had already ' +
    'finished. Before you create, clone, deploy, publish or write anything, check whether ' +
    'it is already there; do not assume a clean slate. Anything the user refers to as ' +
    'already done was probably done by that agent.\n' +
    '</prior_agent_context_lost>'
  );
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

/**
 * `yaar://windows/{id}/history` — what has been done to a window, and putting it back.
 *
 * The server has always kept every `app_command` sent to a window, because a remount
 * rebuilds the document by replaying them (`AppWindowCoordinator.replayCommands`). This
 * file opens that log to agents:
 *
 *   list('yaar://windows/{w}/history')              → one link per entry, oldest first
 *   read('yaar://windows/{w}/history')              → the entries as JSON
 *   read('yaar://windows/{w}/history/{seq}')        → one entry with its full params
 *   invoke('yaar://windows/{w}/history', { action: 'restore', upTo })
 *                                                   → forget everything after `upTo`, remount
 *
 * An agent picking a window up mid-way reads the history instead of re-deriving it from
 * its context; one that took a wrong turn restores to the last good step instead of
 * closing the window and starting over.
 *
 * The limit is the log's own: it holds what *agents* did. State the user produced inside
 * the window (typed text, a chosen tab) was never a command, so a restore brings back the
 * agent's view of the app, not the user's — the same truth replay has always had, now
 * named in the response. Commands the app declares `replay: 'never'` for are in the log
 * but not re-sent on restore, and the restore response says how many.
 */

import type { OSAction } from '@yaar/shared';
import type { VerbResult } from '../../handlers/uri-registry.js';
import { ok, okJsonResource, okLinks, error, prependNote } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getAgentId } from '../../agents/agent-context.js';
import type { WindowHistoryEntry, WindowStateRegistry } from '../../session/window-state.js';
import { formatWindowRef, requireWindowExists } from './helpers.js';

export function historyUri(windowId: string, seq?: number): string {
  return `yaar://windows/${windowId}/history${seq === undefined ? '' : `/${seq}`}`;
}

/** The `history` sub-path, or null when the sub-path is something else. */
export function parseHistorySubPath(subPath: string): { seq?: number } | null {
  if (subPath === 'history') return {};
  const m = /^history\/(\d+)$/.exec(subPath);
  if (!m) return null;
  return { seq: Number(m[1]) };
}

const PARAMS_PREVIEW = 80;

function previewParams(params: unknown): string {
  if (params === undefined) return '';
  let text: string;
  try {
    text = JSON.stringify(params);
  } catch {
    text = String(params);
  }
  return text.length > PARAMS_PREVIEW ? `${text.slice(0, PARAMS_PREVIEW - 1)}…` : text;
}

function entryLine(entry: WindowHistoryEntry): string {
  const who = entry.agentId ? ` by ${entry.agentId}` : '';
  if (entry.kind === 'event')
    return `[${entry.event}]${who}${entry.detail ? ` — ${entry.detail}` : ''}`;
  const params = previewParams(entry.params);
  const status = entry.ok ? '' : ` — FAILED: ${entry.error ?? 'error'}`;
  return `${entry.command}(${params})${who}${status}`;
}

function toJson(entry: WindowHistoryEntry) {
  return { ...entry, at: new Date(entry.at).toISOString() };
}

function droppedNote(dropped: number): string | undefined {
  return dropped
    ? `the first ${dropped} entries fell off the cap; the log starts mid-way`
    : undefined;
}

export function listHistory(windowState: WindowStateRegistry, windowId: string): VerbResult {
  const existsErr = requireWindowExists(windowState, windowId);
  if (existsErr) return existsErr;
  const { entries, dropped } = windowState.getWindowHistory(windowId);
  if (entries.length === 0) {
    return ok(
      `No history for window "${formatWindowRef(windowId)}" yet — no app_command has been ` +
        'sent to it since it opened.',
    );
  }
  const links = entries.map((entry) => ({
    uri: historyUri(windowId, entry.seq),
    name: `history/${entry.seq}`,
    description: entryLine(entry),
  }));
  const notes = [
    `${entries.length} entries, oldest first; read one for its full params, or ` +
      `invoke("${historyUri(windowId)}", { action: "restore", upTo: <seq> }) to put the window back there`,
    droppedNote(dropped),
  ].filter((n): n is string => !!n);
  return prependNote(okLinks(links), notes.join('; '));
}

export function readHistory(
  windowState: WindowStateRegistry,
  windowId: string,
  seq?: number,
): VerbResult {
  const existsErr = requireWindowExists(windowState, windowId);
  if (existsErr) return existsErr;
  const { entries, dropped } = windowState.getWindowHistory(windowId);
  if (seq !== undefined) {
    const entry = entries.find((e) => e.seq === seq);
    if (!entry) {
      return error(
        `No history entry ${seq} on window "${formatWindowRef(windowId)}". ` +
          `list("${historyUri(windowId)}") shows the ones it has.`,
      );
    }
    return okJsonResource(historyUri(windowId, seq), toJson(entry));
  }
  return okJsonResource(historyUri(windowId), {
    windowId,
    count: entries.length,
    ...(dropped ? { dropped, note: droppedNote(dropped) } : {}),
    entries: entries.map(toJson),
  });
}

/**
 * `restore`: truncate the log after `upTo` and remount. The remount's re-registration
 * replays what is left — the exact path a `reload` takes, so restore introduces no second
 * way of rebuilding a window.
 */
export function restoreHistory(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): VerbResult {
  const existsErr = requireWindowExists(windowState, windowId);
  if (existsErr) return existsErr;
  const win = windowState.getWindow(windowId)!;
  if (win.content.renderer !== 'iframe') {
    return error(
      `Window "${formatWindowRef(windowId)}" is not an app window; it has no history to restore.`,
    );
  }
  const agentId = getAgentId();
  const lockedBy = windowState.isLockedByOther(windowId, agentId);
  if (lockedBy)
    return error(`Window "${formatWindowRef(windowId)}" is locked by agent "${lockedBy}".`);

  const upTo = payload.upTo;
  if (typeof upTo !== 'number' || !Number.isInteger(upTo) || upTo < 0) {
    return error(
      '"upTo" (integer seq, 0 to forget everything) is required for restore. ' +
        `list("${historyUri(windowId)}") shows the seqs.`,
    );
  }
  const { entries } = windowState.getWindowHistory(windowId);
  if (upTo > 0 && !entries.some((e) => e.seq === upTo)) {
    return error(
      `No history entry ${upTo} on window "${formatWindowRef(windowId)}". ` +
        `list("${historyUri(windowId)}") shows the ones it has.`,
    );
  }

  const removed = windowState.truncateWindowHistory(windowId, upTo);
  const kept = windowState.getAppCommands(windowId);
  const noReplay = windowState.getNoReplayCommands(windowId);
  const skipped = kept.filter((r) => r.kind === 'command' && noReplay.has(r.command)).length;
  windowState.recordWindowEvent(
    windowId,
    'restored',
    `to seq ${upTo}; ${removed.length} later entr${removed.length === 1 ? 'y' : 'ies'} forgotten`,
    agentId,
  );
  actionEmitter.emitAction({ type: 'window.reload', windowId } satisfies OSAction);

  return ok(
    `Restoring window "${formatWindowRef(windowId)}" to history seq ${upTo}: ${removed.length} ` +
      `later entr${removed.length === 1 ? 'y' : 'ies'} forgotten, ${kept.length - skipped} command(s) ` +
      'will be replayed once the app re-registers' +
      (skipped ? ` (${skipped} skipped — the app declares them replay: 'never')` : '') +
      '. Only what agents sent comes back: state the user produced inside the window is not ' +
      'in the history.',
  );
}

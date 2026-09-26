/**
 * App protocol logic (app_query and app_command).
 */

import type { AppManifest, AppProtocolRequest, AppProtocolResponse } from '@yaar/shared';
import { isPreviewAppId } from '@yaar/shared';
import {
  isContentBlocks,
  ok,
  okJson,
  error,
  jsonText,
  type ContentBlock,
  type VerbResult,
} from '../../lib/verb-result.js';
import {
  hasLineFilter,
  applyReadOptionsToValue,
  type ReadOptions,
} from '../../lib/read-options.js';
import { getActiveSessionId } from '../../handlers/utils.js';
import { getAgentId } from '../../agents/agent-context.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { buildWindowResourceUri } from '../../lib/yaar-uri-server.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { type PendingOutcome } from '../../session/pending-store.js';
import { clientAwayNote } from '../../session/client-presence.js';
import { takeResponderSwitchNote } from '../../session/app-window-coordinator.js';
import { deadlines } from '../../config.js';
import { enrichManifestWithUris } from './manifest-utils.js';
import {
  renderSignature,
  renderInvokeExample,
  reservedKeyNote,
} from '../../lib/command-signature.js';
import { defsOf, selfContained } from '../../lib/schema-refs.js';
import { withoutPersonaCommands } from '../apps/persona-commands.js';
import { grantsFromPayload, undelegatedUris } from './delegated-grants.js';
import { splitStatePath, selectStatePath } from '../../lib/state-path.js';
import {
  gatedStoragePath,
  gatedStoragePathError,
  isStorageOverrideCommand,
} from './storage-override-path.js';

/** Max text size for app protocol results (bytes). Keeps tool output under Claude Code limits. */
const MAX_TEXT_BYTES = 400_000;

// The deadlines this file waits on — `deadlines.appQueryMs` (reading state is near-instant),
// `deadlines.appCommandMs` (commands do real work: devtools' compile/deploy shells out), and
// `deadlines.appCommandMinMs` (the floor under a caller's own timeout) — live in config.ts,
// so a liveness test can shrink them to tens of milliseconds. Read at call time, never
// captured into a module constant.

/** Ceiling for a caller-supplied command timeout. Must fit inside MAX_REQUEST_DEADLINE_MS. */
export const MAX_COMMAND_TIMEOUT_MS = 180_000;

/** Truncate text to MAX_TEXT_BYTES, appending a note if truncated. */
function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_BYTES) return text;
  return (
    text.slice(0, MAX_TEXT_BYTES) + `\n... (truncated, ${(text.length / 1024).toFixed(0)}KB total)`
  );
}

/**
 * Wrap an app protocol value into a VerbResult.
 *
 * Apps can return content blocks directly for fine-grained control:
 *   [{type:'text', text:'...'}, {type:'image', data:'base64', mimeType:'image/webp'}]
 *
 * Plain values (strings, objects) are auto-wrapped and truncated.
 *
 * `read` carries a state read's `lines`/`pattern` filter and the URI it is labelled with.
 * The filter runs *before* truncation, so a match past the cut is still found, and its
 * result is text-only: a `structuredContent` copy beside it would be the unfiltered value,
 * and it is that copy the model would read. Content blocks are the app's own shaping and
 * are left alone — the registry then notes the filter was not applied.
 *
 * An empty value means different things on the two paths. A command that returns nothing
 * finished, so it says "Done.". A state key that holds nothing *is* null, and says `null`
 * — which `toEnvelope` parses back to a real `null` for SDK callers. Answering "Done." to
 * a read made an empty selection indistinguishable from a command result (#103).
 */
function wrapAppValue(value: unknown, read?: { label: string; options?: ReadOptions }): VerbResult {
  if (value === undefined || value === null) return ok(read ? 'null' : 'Done.');

  if (read && hasLineFilter(read.options) && !isContentBlocks(value)) {
    // App state walks paths (`handleAppQuery`), so a search's paths are addressable here.
    const text = applyReadOptionsToValue(value, read.label, read.options, true);
    return { content: [{ type: 'text', text: truncateText(text) }], readFiltered: true };
  }

  if (isContentBlocks(value)) {
    // Truncate text/resource blocks, pass image/resource_link blocks as-is
    const content = value.map((block): ContentBlock => {
      if (block.type === 'text') return { ...block, text: truncateText(block.text) };
      if (block.type === 'resource' && 'text' in block.resource) {
        return {
          type: 'resource',
          resource: { ...block.resource, text: truncateText(block.resource.text) },
        };
      }
      return block;
    });
    return { content };
  }

  if (typeof value === 'string') return ok(truncateText(value));

  // Object → a JSON text block for logs PLUS a lossless `structuredContent` copy
  // for programmatic consumers (app→app SDK calls). The text block is `jsonText`'s
  // (compact when large, or when an array) and truncated; the structured copy is
  // the full value. Note the model reads the *structured* copy — both the Claude CLI
  // and Codex prefer it over text blocks (see `okJson` in lib/verb-result.ts) — so
  // MAX_TEXT_BYTES does not bound what reaches the model context for an object return.
  //
  // `structuredContent` is object-only (MCP contract), so bare arrays get the
  // text-only shape and still round-trip via `toEnvelope`'s tryParseJson.
  if (typeof value === 'object') {
    const content = [{ type: 'text' as const, text: truncateText(jsonText(value)) }];
    return Array.isArray(value)
      ? { content }
      : { content, structuredContent: value as Record<string, unknown> };
  }

  return ok(String(value));
}

/**
 * Ensure app protocol is ready, waiting if needed. Returns error on timeout.
 *
 * `windowKey` must be the resolved window key (`win.id`), not the raw AI-facing id.
 * Readiness is tracked per session *and* per window: a raw id names one window per
 * monitor (so the same app on two monitors would share a key), and a window key names one
 * window per *session* (so two browsers on the same YAAR would share one). Both scopes are
 * needed — the second one is why a fresh session used to find an app "already ready" that
 * had never registered in it, and send its first command into an iframe that was not
 * listening.
 *
 * The fast path stays fast: a window this session has already seen register carries
 * `appProtocol` in its own registry, so a re-entrant command never re-enters the wait.
 */
async function requireAppReady(
  windowState: WindowStateRegistry,
  windowKey: string,
  sessionId?: string,
): Promise<VerbResult | null> {
  const win = windowState.getWindow(windowKey);
  if (win && !win.appProtocol) {
    // The session named here must be the one the `windowState` above came from —
    // `getActiveSessionId()` resolves it the same way (`getWindowState()` in mcp/server.ts
    // and handlers/index.ts do): agent context first, default session outside a turn.
    // Anything else would gate the readiness check on a *different* session's desktop.
    const askedAt = Date.now();
    const ready = await actionEmitter.waitForAppReady(
      sessionId ?? getActiveSessionId(),
      windowKey,
      deadlines.appReadyMs,
    );
    if (!ready)
      return error(
        withPresenceNote(
          'App did not register with the App Protocol (timeout).',
          askedAt,
          sessionId,
        ),
      );
  }
  return null;
}

async function request(
  windowKey: string,
  req: AppProtocolRequest,
  timeoutMs: number,
  sessionId?: string,
): Promise<PendingOutcome<AppProtocolResponse>> {
  return await actionEmitter.emitAppProtocolRequest(windowKey, req, timeoutMs, sessionId);
}

/**
 * Read every declared state key for a handoff snapshot.
 *
 * This is server lifecycle work, not an agent tool call: it names the session explicitly
 * and returns `null` unless the whole snapshot is authoritative. A partial snapshot could
 * turn one timed-out key into a false "state changed" notice on the next invocation.
 */
export async function captureDeclaredAppState(
  windowState: WindowStateRegistry,
  windowId: string,
  stateKeys: readonly string[],
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const win = windowState.getWindow(windowId);
  if (!win || win.content.renderer !== 'iframe') return null;

  const key = win.id;
  const readyErr = await requireAppReady(windowState, key, sessionId);
  if (readyErr) return null;

  const entries = await Promise.all(
    [...stateKeys].sort().map(async (stateKey) => {
      const outcome = await request(
        key,
        { kind: 'query', stateKey },
        deadlines.appQueryMs,
        sessionId,
      );
      if (!outcome.ok) return null;
      const response = outcome.value;
      if (response.kind !== 'query' || response.error) return null;
      return [stateKey, response.data] as const;
    }),
  );
  if (entries.some((entry) => entry === null)) return null;
  return Object.fromEntries(entries as Array<readonly [string, unknown]>);
}

/**
 * Append what the desktop was doing, when a wait ended in silence.
 *
 * A timeout can mean the app is wedged or it can mean nothing was running to hear the
 * question. Only the first is worth retrying, and only the first is the app's fault — so
 * where the server knows which it was, it says so rather than leaving the agent to read
 * "the app did not respond" and believe it. Returns the message unchanged when the desktop
 * was there throughout, which is the ordinary case.
 */
function withPresenceNote(message: string, waitStartedAt: number, sessionId?: string): string {
  const note = clientAwayNote(sessionId ?? getActiveSessionId(), waitStartedAt);
  return note ? `${message} ${note}` : message;
}

/**
 * Append the one-time notice that this answer came from a different tab's copy of the
 * window than the caller's earlier requests (see `AppWindowCoordinator.pickResponder`).
 * An answer from a copy with different in-memory state reads as the app having silently
 * forgotten what it was told; saying so is what lets the agent re-establish it.
 */
function withResponderNote(result: VerbResult, windowKey: string): VerbResult {
  const note = takeResponderSwitchNote(getActiveSessionId(), windowKey);
  if (!note) return result;
  return { ...result, content: [...(result.content ?? []), { type: 'text', text: note }] };
}

/** The message an agent sees when an app never answered. */
function noAnswer(
  outcome: { ok: false; reason: 'timeout' | 'cancelled' | 'closed' },
  what: string,
  waitStartedAt: number,
  sessionId?: string,
): string {
  switch (outcome.reason) {
    case 'cancelled':
      return `The session ended before the app answered the ${what}.`;
    case 'closed':
      return windowClosedMessage(what);
    default:
      return withPresenceNote(
        `App did not respond to the ${what} (timeout).`,
        waitStartedAt,
        sessionId,
      );
  }
}

/**
 * What an agent is told when the window it was talking to closed mid-request.
 *
 * Says "may well have succeeded" rather than reporting a failure, because the commonest
 * way to reach here is a command that *did what it was asked* — `closeWindow`, a deploy
 * that retires its own window — and the responder went down with the work it completed.
 * A flat error here would send the caller off to re-run an operation that already ran.
 */
function windowClosedMessage(what: string): string {
  return (
    `The window closed while the ${what} was in flight, so no answer can arrive. ` +
    'If the request was what closed it, it may well have succeeded — check the ' +
    'resulting state rather than retrying, and note that raising timeoutMs cannot help.'
  );
}

/**
 * The deadline for a call that accepts a caller-supplied `timeoutMs`.
 *
 * Shared by `app_command` and `app_eval` so the floor and the ceiling are the same
 * number in both: a caller cannot ask for less room than a call needs to happen at
 * all, nor for more than the transport can hold open (see MAX_COMMAND_TIMEOUT_MS).
 */
function resolveTimeout(payload: Record<string, unknown>, fallbackMs: number): number {
  const requested = payload.timeoutMs;
  return typeof requested === 'number' && Number.isFinite(requested)
    ? Math.min(Math.max(requested, deadlines.appCommandMinMs), MAX_COMMAND_TIMEOUT_MS)
    : fallbackMs;
}

export async function handleAppQuery(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
  readOptions?: ReadOptions,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  // Address the window by its resolved key (monitor-scoped), never the raw id the
  // caller passed: the frontend routes a raw id by whichever monitor the *user* is
  // looking at, which is not necessarily the monitor of the agent that asked.
  const key = win.id;
  const requested = (payload.stateKey as string) || 'manifest';
  // `scene/nodes/abc/geometry` asks the app for `scene` and walks the rest here — see
  // state-path.ts. `requested` stays the label, so a filtered read names what it filtered.
  const { key: stateKey, path } = splitStatePath(requested);
  const answer = (value: unknown): VerbResult => {
    if (path.length === 0) return withResponderNote(wrapAppValue(value, read), key);
    const selected = selectStatePath(value, stateKey, path);
    return withResponderNote(
      selected.ok ? wrapAppValue(selected.value, read) : error(selected.message),
      key,
    );
  };

  // '__console' is a built-in state key answered by the injected app-protocol
  // script (reads the console-capture buffer) — it works even when the app
  // never registered, so don't wait for app-ready.
  if (stateKey !== '__console') {
    const readyErr = await requireAppReady(windowState, key);
    if (readyErr) return readyErr;
  }

  const read = {
    label: buildWindowResourceUri(windowId, 'state', requested),
    options: readOptions,
  };

  if (stateKey === 'manifest') {
    const askedAt = Date.now();
    const outcome = await request(key, { kind: 'manifest' }, deadlines.appQueryMs);
    if (!outcome.ok) return error(noAnswer(outcome, 'manifest request', askedAt));
    const response = outcome.value;
    if (response.kind !== 'manifest') return error('Unexpected response kind.');
    if (response.error) return error(response.error);
    if (response.manifest) enrichManifestWithUris(response.manifest, win.id, windowState.handleMap);
    // The live manifest comes from the iframe, so the disk-side filter in
    // `discovery.ts` never saw it: strip persona-audience commands here too, for the
    // same reason — they are described to the sub-agent in character voice at spawn,
    // and an app agent reading that description reads the wrong script.
    return answer(response.manifest ? withoutPersonaCommands(response.manifest) : null);
  }

  const askedAt = Date.now();
  const outcome = await request(key, { kind: 'query', stateKey }, deadlines.appQueryMs);
  if (!outcome.ok) return error(noAnswer(outcome, `query "${stateKey}"`, askedAt));
  const response = outcome.value;
  if (response.kind !== 'query') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  return answer(response.data);
}

/**
 * The live manifest as an object, for callers that need to read it rather than hand it
 * to a model — `describe` on a window, and the static-description fallback below.
 *
 * Returns null (rather than waiting out `appReadyMs`) when the iframe has not
 * registered: `describe` has a disk-side answer to fall back to, and making it block for
 * the full readiness deadline to discover that would be the wrong trade.
 */
export async function fetchLiveManifest(
  windowState: WindowStateRegistry,
  windowId: string,
): Promise<AppManifest | null> {
  const win = windowState.getWindow(windowId);
  if (!win || win.content.renderer !== 'iframe' || !win.appProtocol) return null;

  const outcome = await request(win.id, { kind: 'manifest' }, deadlines.appQueryMs);
  if (!outcome.ok) return null;
  const response = outcome.value;
  if (response.kind !== 'manifest' || response.error || !response.manifest) return null;
  enrichManifestWithUris(response.manifest, win.id, windowState.handleMap);
  return withoutPersonaCommands(response.manifest);
}

/**
 * Handle a per-key describe — `describe('yaar://windows/{id}/{state,commands}/{key}')`.
 *
 * Three outcomes, and the middle one is the reason this is not simply "error unless the
 * app defined a describe()":
 *
 * | case                              | result                          |
 * |-----------------------------------|---------------------------------|
 * | key not in the manifest           | error                           |
 * | key exists, no `describe()`       | the manifest's static description |
 * | key exists, handler defined       | the app's computed doc          |
 *
 * `protocol.json` already carries a one-line `description` per key, so erroring on a key
 * that *is* documented would report it as missing — the same false signal the `exists`
 * hook exists to remove. The error is reserved for a key that does not exist.
 *
 * A command's answer additionally carries *how to call it*: a signature, a rendered
 * `invoke` example, and — when the command declares one of the names the sub-path
 * spelling otherwise reserves — a note saying so. The prose those replace ("the payload
 * *is* `params`") reads as a prohibition on a payload containing a key called `params`,
 * which is exactly the shape `setGeometryParams(id, params, points)` needs; a rendered
 * example carrying the literal keys cannot be read that way. That costs a manifest fetch
 * on the computed-doc path, which used to skip it — a describe is a deliberate, rare call,
 * and answering "what does this do" without "how do I call it" is what sent callers back
 * for a second one.
 */
export async function handleAppDescribe(
  windowState: WindowStateRegistry,
  windowId: string,
  target: 'state' | 'commands',
  key: string,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  const windowKey = win.id;
  const readyErr = await requireAppReady(windowState, windowKey);
  if (readyErr) return readyErr;

  const askedAt = Date.now();
  const outcome = await request(
    windowKey,
    { kind: 'describe', target, key },
    deadlines.appQueryMs,
    undefined,
  );
  if (!outcome.ok) return error(noAnswer(outcome, `describe of ${target} "${key}"`, askedAt));
  const response = outcome.value;
  if (response.kind !== 'describe') return error('Unexpected response kind.');
  // The app says this key is not in its table — the one genuine "no such resource".
  if (response.error) return error(response.error);

  const uri = buildWindowResourceUri(windowId, target, key);
  if (response.doc !== null && target === 'state') {
    return okJson({ uri, doc: response.doc });
  }

  // The manifest is read for its own one-liner when the app computed none, and for the
  // params of a command either way.
  const manifest = await fetchLiveManifest(windowState, windowId);
  const table = target === 'state' ? manifest?.state : manifest?.commands;
  const entry = table?.[key] as { description?: string; params?: unknown } | undefined;

  if (target === 'state') {
    return okJson({ uri, doc: entry?.description ?? null, source: 'manifest' });
  }

  // Shared subschemas live on the manifest, not on the descriptor. This answer is one
  // command sliced out of it, so the schema has to carry the defs it points at — a
  // slice with a dangling `#/$defs/...` is corrupt, and it is exactly the door an
  // agent reaches for when a signature left it unsure.
  const defs = defsOf(manifest);
  const note = reservedKeyNote(entry, defs);
  return okJson({
    uri,
    doc: response.doc ?? entry?.description ?? null,
    // Attribution belongs to the doc, so it is claimed only when the doc came from here.
    ...(response.doc === null ? { source: 'manifest' } : {}),
    ...(entry
      ? {
          signature: renderSignature(key, entry, defs),
          invoke: renderInvokeExample(uri, entry, defs),
        }
      : {}),
    ...(entry?.params !== undefined ? { schema: selfContained(entry.params, defs) } : {}),
    ...(note ? { note } : {}),
  });
}

/**
 * Window ids devtools gives its preview windows (`apps/devtools/src/preview.ts`).
 * The id is monitor-scoped by the time it reaches us (`0/devtools-preview-x`), so
 * match the last segment, not the whole string.
 */
const PREVIEW_WINDOW_PREFIX = 'devtools-preview-';

/**
 * Whether a window is a devtools preview — the only kind `app_eval` may touch.
 *
 * Two conditions, both required, because either alone is forgeable by an ordinary
 * app: any app can ask for a window named `devtools-preview-x`, and a window can
 * carry no appId at all (devtools' own scratch preview does). So the id must look
 * like a preview *and* the identity must not be a real app's — a window claiming
 * the preview name while running as `notes` is exactly the confusion this rejects.
 */
export function isPreviewWindow(win: { id: string; appId?: string }): boolean {
  const segment = win.id.slice(win.id.lastIndexOf('/') + 1);
  if (!segment.startsWith(PREVIEW_WINDOW_PREFIX)) return false;
  return win.appId === undefined || isPreviewAppId(win.appId);
}

/**
 * Handle app_eval: evaluate an expression inside a devtools preview iframe.
 *
 * Scoped hard to preview windows. A preview is a disposable sandbox devtools just
 * built from source it is already editing, so eval there grants an agent nothing it
 * could not get by editing the source and recompiling — it only saves the four-step
 * loop (plant debug command → compile → read → remove → recompile) that asking a
 * running app a one-off question otherwise costs. That reasoning does not extend to
 * a user's real, installed apps holding real data, which is why this is not a
 * general app-protocol verb and why the guard is a hard refusal rather than a
 * permission an app could be granted.
 */
export async function handleAppEval(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  if (!isPreviewWindow(win)) {
    return error(
      `app_eval is refused for window "${windowId}": it is not a devtools preview. ` +
        'Arbitrary evaluation is allowed only in the throwaway preview windows devtools ' +
        'builds from source (window id "devtools-preview-{projectId}"). To drive a real ' +
        'app, use its declared commands via app_command.',
    );
  }

  const expression = payload.expression;
  if (typeof expression !== 'string' || !expression.trim()) {
    return error('"expression" (non-empty string) is required for app_eval.');
  }

  // An expression is awaited if it returns a promise, so an eval is only *usually* as
  // instant as a query: `new Promise(r => setTimeout(r, 9000))` is a legitimate thing to
  // ask a preview, and under the fixed query deadline every such expression came back as
  // "the app did not respond" — indistinguishable from a preview that had actually died,
  // and unfixable from the call site because there was no timeout to raise. So the query
  // deadline is the default here, not the rule: a caller that knows its expression is slow
  // says so, under the same floor and ceiling as app_command.
  const timeoutMs = resolveTimeout(payload, deadlines.appQueryMs);
  // No requireAppReady: the eval responder is part of the injected app-protocol
  // script and answers whether or not the app ever registered. Waiting
  // on readiness would make eval unusable for exactly the broken-app case it is
  // most useful for. (Same reasoning as the built-in `__console` state key.)
  const askedAt = Date.now();
  const outcome = await request(win.id, { kind: 'eval', expression }, timeoutMs);
  if (!outcome.ok) {
    if (outcome.reason === 'cancelled')
      return error('The session ended before the app answered the eval request.');
    if (outcome.reason === 'closed') return error(windowClosedMessage('eval request'));
    return error(
      withPresenceNote(
        `Preview did not answer the eval within ${(timeoutMs / 1000).toFixed(0)}s. If the ` +
          'expression is legitimately slow — it awaits a promise, sleeps, or waits on a ' +
          `render — retry with a larger timeoutMs (max ${MAX_COMMAND_TIMEOUT_MS / 1000}s). ` +
          'Note that the deadline of whatever call is wrapping this one applies too, so raise ' +
          'that at the same time.',
        askedAt,
      ),
    );
  }
  const response = outcome.value;
  if (response.kind !== 'eval') return error('Unexpected response kind.');
  if (response.error) return error(response.error);
  return ok(response.value ?? 'undefined');
}

export async function handleAppCommand(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);

  if (!payload.command) return error('"command" is required for app_command.');

  // See handleAppQuery: address the window by its monitor-scoped key, not the raw id.
  const key = win.id;
  const readyErr = await requireAppReady(windowState, key);
  if (readyErr) return readyErr;

  const params = payload.params as Record<string, unknown> | undefined;
  const req: AppProtocolRequest = { kind: 'command', command: payload.command as string, params };

  // A storage override is promised a path it can resolve on its own authority; one past
  // the commons is refused here, for every door (see storage-override-path.ts). The
  // manifest is only fetched to resolve an alias, and only once such a path is named.
  const gatedPath = gatedStoragePath(params);
  if (gatedPath !== null) {
    const commands = req.command.startsWith('storage:')
      ? undefined
      : (await fetchLiveManifest(windowState, windowId))?.commands;
    if (isStorageOverrideCommand(req.command, commands))
      return error(gatedStoragePathError(req.command, gatedPath));
  }

  // A storage file named in the params is a file the caller is handing to this app —
  // grant it before the command runs, or the app 403s on the one path it was just told
  // about. `grantsFromPayload` returns nothing unless the caller outranks the app, so
  // an app driving another app's window through `yaar://windows/` grants nothing.
  windowState.grantWindowAccess(key, grantsFromPayload(req.params));
  // The other half of that sentence: when the caller may *not* delegate, remember which
  // paths it named, so the 403 the app is about to get says which refusal it is rather
  // than reading as a missing app.json permission. Diagnostics only — see
  // `undelegatedUris`.
  windowState.noteUndelegatedUris(key, undelegatedUris(req.params));

  const timeoutMs = resolveTimeout(payload, deadlines.appCommandMs);

  const agentId = getAgentId();
  const askedAt = Date.now();
  const outcome = await request(key, req, timeoutMs);
  if (!outcome.ok) {
    if (outcome.reason === 'cancelled')
      return error('The session ended before the app answered the command.');
    if (outcome.reason === 'closed') return error(windowClosedMessage(`\`${req.command}\``));
    const message = withPresenceNote(
      `App did not respond within ${(timeoutMs / 1000).toFixed(0)}s. If this command is ` +
        `legitimately slow, retry with a larger timeoutMs (max ${MAX_COMMAND_TIMEOUT_MS / 1000}s).`,
      askedAt,
    );
    // A timeout is history too: the app may well have applied the command before the
    // deadline passed, and a reader of the log should see that it was sent.
    windowState.recordAppCommand(key, req, { ok: false, error: 'timeout' }, agentId);
    return error(message);
  }
  const response = outcome.value;
  if (response.kind !== 'command') return error('Unexpected response kind.');
  if (response.error) {
    windowState.recordAppCommand(key, req, { ok: false, error: response.error }, agentId);
    return withResponderNote(error(response.error), key);
  }
  windowState.recordAppCommand(key, req, { ok: true }, agentId);
  return withResponderNote(wrapAppValue(response.result), key);
}

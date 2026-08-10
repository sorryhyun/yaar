export {};
import { errMsg, invoke, read, AppCommandError } from '@bundled/yaar';
import {
  activeProject,
  buildSerial,
  previewBuildSerial,
  previewIsStale,
  previewUrl,
  previewWindowId,
  setPreviewBuildSerial,
  setPreviewWindowId,
  type ConsoleEntry,
} from '../core';
import { addConsoleEntry } from './console';
import { getRuntimeManifest } from './manifest';

// Preview window mechanics: how it is opened and how pixels are read back out.
//
// Only the helpers live here, not the preview *commands*. The app protocol
// manifest is produced by statically reading the `commands` object literal in
// protocol.ts, so a command reached via a spread (`...previewCommands`) compiles
// and runs fine but vanishes from the manifest — leaving agents unable to see it.
// Command definitions therefore stay inline in protocol.ts; the bodies they call
// are what gets factored out.

export interface CapturedImage {
  data: string;
  mimeType: string;
}

/**
 * Turn a capture failure reason into something actionable.
 *
 * The old message guessed ("may not have painted yet — retry") for every failure,
 * which is right for exactly one of these and actively misleading for the rest:
 * a tainted canvas fails the same way forever, so the advice to retry burned turns
 * on a capture that could never succeed.
 */
export function captureFailureHint(reason: string): string {
  switch (reason) {
    case 'taint':
      return (
        'An external resource tainted the canvas, so the browser refuses to read its ' +
        'pixels. Retrying will not help — find the non-`data:` URL in the DOM ' +
        '(an <img>, a CSS url(), a <video>) and inline or remove it. Meanwhile use ' +
        'previewEval to check structure instead of pixels.'
      );
    case 'no-response':
      return (
        'The preview never answered the capture request: either no capture handler is ' +
        'installed (an old build — recompile and re-open the preview) or the page is ' +
        'busy blocking the main thread. Check previewConsole for a stuck script.'
      );
    case 'zero-size':
      return (
        'The preview has no layout box yet — the window is not laid out, or the app ' +
        'renders into a zero-size container. Retry after a moment; if it persists, ' +
        'check the root element has a height (resizePreview can also give it room).'
      );
    case 'serialize-error':
      return (
        'Serializing the DOM for capture threw. Usually a node the cloner cannot handle ' +
        '(exotic embeds, a huge tree). Use previewEval to inspect structure instead.'
      );
    case 'img-load-error':
      return (
        'The serialized snapshot failed to load as an image — typically malformed markup ' +
        'in the DOM. Use previewEval to inspect structure instead.'
      );
    default:
      return `Capture failed (${reason}).`;
  }
}

/**
 * Open (or re-open) the preview window on the current build, and return where it landed.
 *
 * Re-creating the window remounts the iframe, which is how a preview picks up a new build —
 * so `compile` calls this too. Shared with the `preview` command rather than duplicated:
 * the window id and the preview principal below are both load-bearing, and a second copy
 * of them that drifted would be its own bug.
 */
export async function openPreview(): Promise<{ previewUrl: string; windowId: string }> {
  const url = previewUrl();
  if (!url) throw new AppCommandError('No compiled output. Run compile first.');
  const proj = activeProject();
  const name = proj?.name ?? 'Preview';
  // The project's declared `permissions` are deliberately *not* passed here. `window.create`
  // honours a caller-supplied list only for a caller that outranks the app it is creating a
  // window for — devtools is an app, so the array was silently discarded and every declared
  // grant 403'd in preview. The server reads the same list off the project's app.json when it
  // mints the preview's token instead (`previewPermissions` in http/iframe-tokens.ts), capped
  // by devtools' own reach, which is also how `bundles` already worked. Nothing to send.
  // Address the window by an explicit, namespaced id. Left to the server, the id is
  // derived by slugging the title — and the title is the project name, so previewing a
  // clone of `ai-chat` produced the window id `ai-chat`, colliding with the *running*
  // app. Window registration is last-write-wins, so the preview silently replaced the
  // real app's window record (and its appId), severing the real app from its agent.
  const previewId = `devtools-preview-${proj?.id ?? 'scratch'}`;
  // Give the preview a principal of its own, derived from the project. `self` then
  // resolves inside it — so appStorage, appDb and app-scoped permissions actually run
  // before deploy instead of 403'ing — while the storage it reaches is a throwaway
  // namespace, not the deployed app's live data. The server refuses to route an app
  // agent to a `preview--*` identity, so this cannot displace the real app either.
  const previewAppId = proj ? `preview--${proj.id}` : undefined;
  // Close before create, unconditionally. `create` on an id that already exists is a
  // hard error server-side (features/window/create.ts) — not a replace — so the create
  // below would throw and take the whole `compile` command down with it, reported as
  // "compile failing" even though the build succeeded. Gating this on previewWindowId()
  // is not enough: that signal is set only here and cleared only in two catch blocks,
  // and nothing subscribes to window close, so it goes stale in both directions. Asking
  // the server to close is the only thing that knows the truth. A close that fails
  // because there was nothing there is the expected case, not an error.
  try {
    await invoke(`yaar://windows/${previewId}`, { action: 'close' });
  } catch {
    /* no such window — that is the normal first-open path */
  }
  const result = await invoke<{ windowId?: string }>(`yaar://windows/${previewId}`, {
    action: 'create',
    title: `${name} (preview)`,
    renderer: 'iframe',
    content: url,
    ...(previewAppId ? { appId: previewAppId } : {}),
  });
  // Trust the id the server actually registered, not the one we asked for.
  const windowId = result?.windowId ?? previewId;
  setPreviewWindowId(windowId);
  // A remount starts the app from zero, so every value in the previous snapshot
  // "changed" — a diff across it would be all noise and no signal.
  resetInspectBaseline();
  // This window now shows the current build; nothing downstream needs to warn.
  setPreviewBuildSerial(buildSerial());
  return { previewUrl: url, windowId };
}

/**
 * The warning a stale preview owes every reader of it, or null when it is current.
 *
 * `compile({ refreshPreview: false })` buys state preservation by leaving the window
 * on the previous build. That is only a safe trade while every window onto the
 * preview says so — an unlabelled screenshot of last build's code is precisely the
 * evidence that makes a wrong fix look confirmed.
 */
export function previewStaleNote(): string | null {
  if (!previewIsStale()) return null;
  const behind = buildSerial() - previewBuildSerial();
  return (
    `STALE PREVIEW: this window is showing a build ${behind} compile(s) old — ` +
    'the source has been compiled since it was mounted, without a refresh ' +
    '(compile({ refreshPreview: false })). Anything you read here describes the ' +
    'older build. Run `preview` to remount on the current one, at the cost of ' +
    'resetting in-app state.'
  );
}

/**
 * Read the preview window: its metadata, and a screenshot of what it is rendering.
 *
 * Reading an iframe window emits a capture whose image the verb layer hands back
 * alongside the JSON, so `read` resolves to `{ data, images }` rather than the bare
 * metadata. A window with nothing to capture yet resolves to the metadata alone —
 * hence both shapes are accepted, and an empty `images` is a real answer ("nothing
 * painted"), not an error to be swallowed here.
 */
export async function readPreview(): Promise<{
  info: Record<string, unknown>;
  images: CapturedImage[];
}> {
  const wid = previewWindowId();
  if (!wid) throw new AppCommandError('No preview window open. Run preview first.');

  let result: unknown;
  try {
    result = await read<unknown>(`yaar://windows/${wid}`);
  } catch {
    setPreviewWindowId(null);
    throw new AppCommandError('Preview window no longer exists.');
  }

  const wrapped = result as { data?: unknown; images?: CapturedImage[] } | undefined;
  const hasImages = Array.isArray(wrapped?.images);
  return {
    info: ((hasImages ? wrapped?.data : result) ?? {}) as Record<string, unknown>,
    images: hasImages ? (wrapped?.images ?? []) : [],
  };
}

/**
 * Evaluate a JS expression inside the preview iframe and return the result as text.
 *
 * Answers questions about a *running* preview that source alone cannot settle —
 * computed styles, element counts, live state — without the plant-a-debug-command,
 * recompile, read, remove, recompile round trip. Also the fallback when a screenshot
 * fails for good (a tainted canvas): structure is still checkable when pixels are not.
 *
 * The server refuses this for anything that is not a devtools preview window, so it
 * is not a door into the user's installed apps.
 */
function formatEvaluationContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    const json = JSON.stringify(content, null, 2);
    return json === undefined ? String(content) : json;
  } catch {
    return String(content);
  }
}

function logPreviewEvaluation(kind: 'input' | 'result' | 'error', content: unknown): void {
  addConsoleEntry({
    level: kind === 'error' ? 'error' : 'info',
    // Keep the complete expression/result in a single argument: ConsolePanel renders
    // args verbatim with pre-wrap, so agents can recover precisely what was evaluated.
    args: [`[preview eval ${kind}]\n${formatEvaluationContent(content)}`],
    timestamp: Date.now(),
    source: 'evaluation',
  });
}

/**
 * The eval round trip with no console audit attached.
 *
 * Split out because `inspect` evaluates on every call and also *reports* the
 * console tail: audit-logging its own probe would put an entry in the buffer that
 * the same snapshot then reads back, so each inspect would show the previous one.
 * A user-authored `previewEval` still gets the audit — that is the record of what
 * an agent asked the preview, and it belongs in the panel.
 */
async function evaluateRaw(wid: string, expression: string, timeoutMs?: number): Promise<unknown> {
  return await invoke<unknown>(`yaar://windows/${wid}`, {
    action: 'app_eval',
    expression,
    // Only when asked for: the server's own default (the app-query deadline) is right
    // for the structural questions eval is mostly used for, and passing a number here
    // unconditionally would bury that default under a devtools-local one.
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

export interface EvaluateWithChanges {
  result: unknown;
  /** What moved between the snapshot taken before the expression ran and after it. */
  changed: NonNullable<InspectResult['changed']>;
  /** The rendered text after the expression — carried only when it actually changed. */
  dom?: InspectedValue;
}

/**
 * Evaluate, and optionally say what the expression *did*.
 *
 * The diff is against a snapshot taken immediately before the expression runs,
 * not against whatever the last inspect happened to see. An eval is asked in
 * order to cause something ("click the button", "call the fetch"), so the only
 * useful attribution is to this call — reusing the standing baseline would credit
 * it with everything that moved since the last time anyone looked.
 */
export async function previewEvaluate(
  expression: string,
  timeoutMs?: number,
  opts: { changed?: boolean } = {},
): Promise<unknown | EvaluateWithChanges> {
  const wid = previewWindowId();
  if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
  logPreviewEvaluation('input', expression);
  const before = opts.changed === true ? await captureSnapshot(wid, { console: false }) : null;
  let result: unknown;
  try {
    result = await evaluateRaw(wid, expression, timeoutMs);
    logPreviewEvaluation('result', result);
  } catch (err) {
    const message = errMsg(err);
    logPreviewEvaluation('error', message);
    throw new AppCommandError(`Preview eval failed: ${message}`);
  }
  if (!before) return result;

  const after = await captureSnapshot(wid, { console: false });
  // Later inspects diff against where the eval left the app, not against the
  // pre-eval state they never saw.
  lastInspect = after;
  const changed = diffSnapshots(before, after);
  return {
    result,
    changed,
    // Only when it moved: the point of returning it is "here is the new render",
    // and 4KB of unchanged text on every probe is noise the caller did not ask for.
    ...(changed.dom ? { dom: after.dom } : {}),
  };
}

// ── Inspect ─────────────────────────────────────────────────────────────────
//
// One read that puts side by side the three things a stale-render bug lives
// between: what the app *declares* (protocol state), what it *renders* (the
// DOM's text), and what it *said* (the console tail). Each was already reachable
// on its own — a single-key query, an eval, consoleLogs — and that is the point.
// The failure this catches is not "the value was unreadable" but "nobody thought
// to compare them": protocol state reading 42 under a DOM still showing 41 is a
// derived value that was never wrapped in a thunk, and neither half alone says so.
//
// It also diffs against the previous snapshot, because the question in front of
// an agent mid-debug is almost never "what is the state" but "what changed since
// the thing I just did".
//
// This is `previewQuery` with no `stateKey`, not a command of its own. Two
// commands over one subsystem meant both descriptions spent their length telling
// an agent which to reach for — and the losing branch, single-key query, is the
// one an agent reaches for by habit when it has no idea where the bug is.

/** Max serialized chars kept per state value. */
const INSPECT_STATE_CHARS = 2000;
/** Max serialized chars across all state values in one snapshot. */
const INSPECT_TOTAL_STATE_CHARS = 12000;
/** Max chars of rendered text kept. */
const INSPECT_DOM_CHARS = 4000;
/** How many console entries ride along. */
const INSPECT_CONSOLE_ENTRIES = 30;

/**
 * Read the text the preview is actually showing.
 *
 * `#app` is the compiler's mount point; falling back to `body` covers an app that
 * failed before mounting, which is exactly when this is worth reading. A caller
 * that names a selector gets that subtree instead — the whole-app text is the
 * right default, and the wrong payload once the interesting region is one row of
 * a list the app renders two hundred of.
 */
const DOM_NO_MATCH = ' yaar-selector-no-match';

function domTextExpression(selector?: string): string {
  const root = selector
    ? `document.querySelector(${JSON.stringify(selector)})`
    : "document.getElementById('app')||document.body";
  // A missing element is reported, not rendered as empty text: "the selector
  // matched nothing" and "the element is empty" are different findings, and an
  // empty string that means the first one sends the reader looking at the app.
  const missing = selector ? JSON.stringify(DOM_NO_MATCH) : "''";
  return `(function(){var r=${root};return r?(r.innerText||r.textContent||''):${missing};})()`;
}

export interface InspectedValue {
  value?: string;
  /** The getter threw. Isolated per key — one bad getter must not void the snapshot. */
  error?: string;
  /** Dropped to stay under the whole-snapshot budget, not because it was unreadable. */
  omitted?: true;
  truncated?: true;
  /** Full length before truncation. */
  chars?: number;
}

export interface InspectSnapshot {
  windowId: string;
  state: Record<string, InspectedValue>;
  /** Why `state` is empty, when the manifest could not be read at all. */
  stateReason?: string;
  /** Keys the budget cut, named rather than silently dropped. */
  stateOmitted?: string[];
  dom: InspectedValue;
  /** Absent on the internal snapshots taken around a `previewEval`, which skip it. */
  console?: { connected: boolean; reason?: string; entries: ConsoleEntry[] };
}

export interface InspectResult extends InspectSnapshot {
  /**
   * What moved since the last snapshot: per-key `{ from, to }` for state, plus a
   * flag for the rendered text. Absent on the first call after a preview opens —
   * there is nothing to compare against, which is not the same as "nothing moved".
   *
   * A key appears only when both sides are known. One that was budget-omitted on
   * either side, or that the other snapshot never read (a narrowed `keys`), is
   * left out rather than reported as having appeared or vanished.
   */
  changed?: {
    state: Record<string, { from: string; to: string }>;
    dom: boolean;
  };
  /**
   * Present only when the window is showing an older build than the last compile.
   * Everything else in this snapshot then describes that older build.
   */
  previewStale?: string;
}

export interface InspectOptions {
  /**
   * Read only these state keys instead of every declared one. Skips the manifest
   * round trip, so an unknown key comes back as a per-key `error` from the app
   * itself (which names the keys it does have) rather than being filtered away here.
   * `[]` reads no state at all — the way to ask for the render alone.
   */
  keys?: string[];
  /** Narrow the rendered-text read to one subtree. Defaults to the whole app. */
  selector?: string;
  /** Include the console tail. Default true. */
  console?: boolean;
}

let lastInspect: InspectSnapshot | null = null;

/** Drop the diff baseline. Called when a preview remounts and its state resets. */
export function resetInspectBaseline(): void {
  lastInspect = null;
}

function serializeInspected(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    // Circular structures and getters that throw mid-walk land here.
    try {
      return String(value);
    } catch {
      return '[unserializable value]';
    }
  }
}

function cap(text: string, max: number): InspectedValue {
  return text.length > max
    ? { value: text.slice(0, max), truncated: true, chars: text.length }
    : { value: text };
}

/**
 * `app_eval` hands back the iframe's *serialized* result, so a string comes back
 * JSON-quoted. Unwrap it, but never at the cost of the answer: text that does not
 * parse is returned as-is rather than discarded.
 */
function unquoteEvalString(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!text.startsWith('"')) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'string' ? parsed : text;
  } catch {
    return text;
  }
}

async function collectState(
  wid: string,
  requested?: string[],
): Promise<Pick<InspectSnapshot, 'state' | 'stateReason' | 'stateOmitted'>> {
  let keys: string[];
  if (requested) {
    if (requested.length === 0) return { state: {} };
    keys = requested;
  } else {
    const manifest = await getRuntimeManifest();
    if (!manifest.names) return { state: {}, stateReason: manifest.reason };
    // `__`-prefixed keys are the built-ins (`__console`), reported separately below.
    keys = manifest.names.state.filter((k) => !k.startsWith('__'));
  }
  // allSettled, not all: a getter that throws is a finding, not a reason to lose
  // the other nineteen values in the snapshot.
  const settled = await Promise.allSettled(
    keys.map((k) => invoke<unknown>(`yaar://windows/${wid}`, { action: 'app_query', stateKey: k })),
  );

  const state: Record<string, InspectedValue> = {};
  const omitted: string[] = [];
  let spent = 0;
  keys.forEach((key, i) => {
    const outcome = settled[i];
    if (outcome === undefined) return;
    if (outcome.status === 'rejected') {
      state[key] = { error: errMsg(outcome.reason) };
      return;
    }
    if (spent >= INSPECT_TOTAL_STATE_CHARS) {
      state[key] = { omitted: true };
      omitted.push(key);
      return;
    }
    const entry = cap(serializeInspected(outcome.value), INSPECT_STATE_CHARS);
    spent += entry.value?.length ?? 0;
    state[key] = entry;
  });

  return { state, ...(omitted.length ? { stateOmitted: omitted } : {}) };
}

async function collectDom(wid: string, selector?: string): Promise<InspectedValue> {
  try {
    const text = unquoteEvalString(await evaluateRaw(wid, domTextExpression(selector)));
    if (selector && text === DOM_NO_MATCH) {
      return { error: `No element matches selector ${JSON.stringify(selector)} in the preview.` };
    }
    return cap(text, INSPECT_DOM_CHARS);
  } catch (err) {
    return { error: errMsg(err) };
  }
}

async function collectConsole(
  wid: string,
): Promise<NonNullable<InspectSnapshot['console']>> {
  try {
    const entries = await invoke<unknown>(`yaar://windows/${wid}`, {
      action: 'app_query',
      stateKey: '__console',
    });
    if (!Array.isArray(entries)) {
      return { connected: false, reason: 'Preview returned no console buffer.', entries: [] };
    }
    return { connected: true, entries: entries.slice(-INSPECT_CONSOLE_ENTRIES) as ConsoleEntry[] };
  } catch (err) {
    return { connected: false, reason: `Preview console unreachable: ${errMsg(err)}`, entries: [] };
  }
}

/** How a value reads for diffing: its text, its error, or the fact it was cut. */
function diffKey(entry: InspectedValue | undefined): string | undefined {
  if (!entry) return undefined;
  if (entry.omitted) return undefined;
  return entry.error !== undefined ? `error: ${entry.error}` : entry.value;
}

function diffSnapshots(
  prev: InspectSnapshot,
  next: InspectSnapshot,
): NonNullable<InspectResult['changed']> {
  const state: Record<string, { from: string; to: string }> = {};
  for (const key of Object.keys(next.state)) {
    const from = diffKey(prev.state[key]);
    const to = diffKey(next.state[key]);
    // `undefined` on either side is *unknown*, not a value: the key was omitted by
    // the budget, or one of the two snapshots narrowed its `keys` and never read it.
    // Reported as a change it would read as "appeared"/"vanished", which is a lie
    // about an app whose declared keys do not move.
    if (from === undefined || to === undefined || from === to) continue;
    state[key] = { from, to };
  }
  const prevDom = diffKey(prev.dom);
  const nextDom = diffKey(next.dom);
  return {
    state,
    dom: prevDom !== undefined && nextDom !== undefined && prevDom !== nextDom,
  };
}

/**
 * One read of the preview's three halves, with no diffing and no baseline effect.
 *
 * They run concurrently: they are independent, and an agent debugging a live app is
 * reading a moving target either way — serializing them would only widen the window
 * over which the three halves disagree.
 */
async function captureSnapshot(wid: string, opts: InspectOptions = {}): Promise<InspectSnapshot> {
  const [statePart, dom, consolePart] = await Promise.all([
    collectState(wid, opts.keys),
    collectDom(wid, opts.selector),
    opts.console === false ? undefined : collectConsole(wid),
  ]);
  return {
    windowId: wid,
    ...statePart,
    dom,
    ...(consolePart ? { console: consolePart } : {}),
  };
}

/** Snapshot the running preview, and say what moved since the last snapshot. */
export async function inspectPreview(opts: InspectOptions = {}): Promise<InspectResult> {
  const wid = previewWindowId();
  if (!wid) throw new AppCommandError('No preview window open. Run preview first.');

  const snapshot = await captureSnapshot(wid, opts);
  const changed = lastInspect ? diffSnapshots(lastInspect, snapshot) : undefined;
  lastInspect = snapshot;
  const stale = previewStaleNote();
  return { ...snapshot, ...(changed ? { changed } : {}), ...(stale ? { previewStale: stale } : {}) };
}

/**
 * Read one declared state key, whole.
 *
 * Deliberately untruncated, unlike the same key inside a snapshot: asking for one
 * key is how you drill into the value the snapshot capped at 2000 chars, and a
 * drill-down that truncates too has nowhere left to go.
 */
export async function queryPreviewState(stateKey: string): Promise<unknown> {
  const wid = previewWindowId();
  if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
  try {
    return await invoke(`yaar://windows/${wid}`, { action: 'app_query', stateKey });
  } catch (err) {
    // The app's own error already names the keys it registers, so it is passed
    // through rather than replaced with a devtools-flavored guess.
    throw new AppCommandError(`Preview query failed: ${errMsg(err)}`);
  }
}

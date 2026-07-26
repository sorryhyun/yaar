/**
 * App Protocol — self-describing JSON contract for agent ↔ iframe app communication.
 *
 * Apps register a manifest describing their capabilities (state keys, commands).
 * The agent discovers capabilities at runtime, then queries state or sends commands.
 *
 * Flow:
 *   Agent → MCP tool → ActionEmitter → WebSocket → Frontend → postMessage → Iframe App
 *   Iframe App → postMessage → Frontend → WebSocket → ActionEmitter resolves → MCP tool returns
 */

// ── File association types ──────────────────────────────────────────

/** Declares which file types an app can open and how to send content to it. */
export interface FileAssociation {
  extensions: string[];
  command: string;
  paramKey: string;
}

// ── Manifest types ──────────────────────────────────────────────────

export interface AppStateDescriptor {
  description: string;
  schema?: object;
}

/**
 * What should happen to this command when a remounted iframe replays the commands
 * it was sent before (see `AppWindowCoordinator.replayCommands`).
 *
 * - `'always'` (the default, and the behavior of every command that says nothing) —
 *   correct for a command whose whole job is to put the app back in a state the agent
 *   chose: `navigate`, `setDeck`, `setAppearance`. Running it twice lands in one place.
 * - `'never'` — the command appends, notifies, or is otherwise one-shot (`addMemo`,
 *   `sendInteraction`), or the app persists its effect itself and does not need telling
 *   again. Replaying it double-applies it, which is the failure this field exists for.
 */
export type AppCommandReplayPolicy = 'always' | 'never';

export interface AppCommandDescriptor {
  description: string;
  aliases?: string[];
  params?: object;
  returns?: object;
  /** Omitted means `'always'` — old apps keep today's replay behavior. */
  replay?: AppCommandReplayPolicy;
}

/**
 * Declares an event channel an app can emit on (via `app.emit(channel, payload)`).
 * Surfaced in the manifest so an agent can discover what it may subscribe to.
 */
export interface AppEventDescriptor {
  description: string;
}

export interface AppManifest {
  appId: string;
  name: string;
  state: Record<string, AppStateDescriptor>;
  commands: Record<string, AppCommandDescriptor>;
  /** Declared event channels this app may emit. Absent for apps that emit nothing. */
  events?: Record<string, AppEventDescriptor>;
  /**
   * Declarative keyboard shortcuts: combo → declared command name, e.g.
   * `{ "ArrowRight": "nextPage", "Ctrl+s": "save" }`. Dispatched inside the app
   * iframe while it has focus; combos without a Ctrl/Meta/Alt modifier are
   * suppressed when an editable element has focus, so `ArrowRight` never steals
   * cursor movement from a text input. `Ctrl` also matches `Cmd`.
   */
  keybindings?: Record<string, string>;
}

// ── Keybinding combos ───────────────────────────────────────────────

/** Modifier tokens a keybinding combo may carry, in canonical order. */
const KEYBINDING_MODIFIERS = ['ctrl', 'meta', 'alt', 'shift'] as const;

/**
 * Combos the OS shell owns globally, in normalized form. The shell handles
 * these before any app sees them — `DesktopSurface` at the document level, and
 * the injected contextmenu iframe script forwards them out of app iframes — so
 * an app binding one would never fire (or worse, fire *and* close the window).
 * The build rejects them; keep in sync with `iframe-scripts/contextmenu.ts`.
 */
export const RESERVED_KEYBINDINGS: ReadonlySet<string> = new Set([
  'shift+tab',
  'ctrl+w',
  'ctrl+r',
  'f5',
  ...Array.from({ length: 9 }, (_, i) => `ctrl+${i + 1}`),
]);

/**
 * Normalize a combo like `"Ctrl+Shift+ArrowRight"` to its canonical
 * `"ctrl+shift+arrowright"` form (lowercase, modifiers in fixed order).
 * Returns null for a combo that can never match: an unknown modifier token, a
 * missing key, or a modifier-only combo like `"Ctrl+Shift"`.
 */
export function normalizeKeybinding(combo: string): string | null {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const key = parts.pop();
  if (!key) return null;
  if ((KEYBINDING_MODIFIERS as readonly string[]).includes(key)) return null;
  const mods = new Set<string>();
  for (const part of parts) {
    if (!(KEYBINDING_MODIFIERS as readonly string[]).includes(part)) return null;
    mods.add(part);
  }
  return [...KEYBINDING_MODIFIERS.filter((m) => mods.has(m)), key].join('+');
}

/**
 * Validate a `keybindings` map against the app's declared command names.
 * Returns one issue per bad entry, keyed by the authored combo — used by both
 * protocol readers so the AST and fold paths reject identically.
 */
export function listKeybindingIssues(
  keybindings: Record<string, string>,
  commandNames: Iterable<string>,
): Array<{ combo: string; issue: string }> {
  const commands = new Set(commandNames);
  const issues: Array<{ combo: string; issue: string }> = [];
  const seen = new Map<string, string>();
  for (const [combo, command] of Object.entries(keybindings)) {
    const normalized = normalizeKeybinding(combo);
    if (normalized === null) {
      issues.push({
        combo,
        issue: `unparseable combo "${combo}" - expected "[Ctrl+][Meta+][Alt+][Shift+]Key" (KeyboardEvent.key names)`,
      });
      continue;
    }
    if (RESERVED_KEYBINDINGS.has(normalized)) {
      issues.push({
        combo,
        issue: `"${combo}" is reserved by the OS shell (Shift+Tab, Ctrl+1-9, Ctrl+W, Ctrl+R, F5)`,
      });
      continue;
    }
    const first = seen.get(normalized);
    if (first !== undefined) {
      issues.push({
        combo,
        issue: `"${combo}" duplicates "${first}" - both normalize to ${normalized}`,
      });
      continue;
    }
    seen.set(normalized, combo);
    if (!commands.has(command)) {
      issues.push({
        combo,
        issue: `bound to "${command}", which is not a declared command name (aliases do not count)`,
      });
    }
  }
  return issues;
}

// ── PostMessage types (parent ↔ iframe) ─────────────────────────────

export interface AppManifestRequest {
  type: 'yaar:app-manifest-request';
  requestId: string;
}

export interface AppManifestResponse {
  type: 'yaar:app-manifest-response';
  requestId: string;
  manifest: AppManifest | null;
  error?: string;
}

export interface AppQueryRequest {
  type: 'yaar:app-query-request';
  requestId: string;
  stateKey: string;
}

export interface AppQueryResponse {
  type: 'yaar:app-query-response';
  requestId: string;
  data: unknown;
  error?: string;
}

export interface AppCommandRequest {
  type: 'yaar:app-command-request';
  requestId: string;
  command: string;
  params?: unknown;
  /**
   * This command is being re-sent to an iframe that remounted, not issued fresh by an
   * agent. Reaches the handler as `ctx.replayed` for the rare command that wants to
   * behave differently rather than opt out wholesale via `replay: 'never'`.
   */
  replayed?: boolean;
}

export interface AppCommandResponse {
  type: 'yaar:app-command-response';
  requestId: string;
  result: unknown;
  error?: string;
}

/**
 * Evaluate an arbitrary expression inside an iframe.
 *
 * Deliberately *not* a general app-protocol capability: the server only dispatches
 * this to devtools preview windows (see `handleAppEval`). It exists so a developer
 * agent can ask a running preview a one-off question — "what is
 * document.querySelectorAll('.row').length?" — instead of the plant-a-debug-command,
 * recompile, read, remove, recompile loop that question otherwise costs.
 */
export interface AppEvalRequest {
  type: 'yaar:app-eval-request';
  requestId: string;
  expression: string;
}

export interface AppEvalResponse {
  type: 'yaar:app-eval-response';
  requestId: string;
  /** JSON-serialized result, size-capped with an explicit truncation marker. */
  value?: string;
  error?: string;
}

/** Fire-and-forget notification sent to iframe before window is destroyed. */
export interface AppCloseNotification {
  type: 'yaar:app-close';
}

/**
 * Fire-and-forget event pushed from the iframe app to the parent (agent side).
 * Emitted via `app.emit(channel, payload)`. The parent resolves the source
 * iframe → windowId (the iframe doesn't know its own windowId).
 */
export interface AppEventMessage {
  type: 'yaar:app-event';
  channel: string;
  payload: unknown;
}

export type AppProtocolPostMessage =
  | AppManifestRequest
  | AppManifestResponse
  | AppQueryRequest
  | AppQueryResponse
  | AppCommandRequest
  | AppCommandResponse
  | AppEvalRequest
  | AppEvalResponse
  | AppCloseNotification
  | AppEventMessage;

// ── WebSocket event types (server ↔ client) ─────────────────────────

/** Server → Client: ask the iframe a question */
export type AppProtocolRequest =
  | { kind: 'manifest' }
  | { kind: 'query'; stateKey: string }
  | { kind: 'command'; command: string; params?: unknown; replayed?: boolean }
  | { kind: 'eval'; expression: string };

/** Client → Server: iframe's answer */
export type AppProtocolResponse =
  | { kind: 'manifest'; manifest: AppManifest | null; error?: string }
  | { kind: 'query'; data: unknown; error?: string }
  | { kind: 'command'; result: unknown; error?: string }
  | { kind: 'eval'; value?: string; error?: string };

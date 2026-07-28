/**
 * Type declarations for @bundled/* imports.
 *
 * Each @bundled/foo import is resolved at build time by the Bun plugin in
 * plugins.ts. This file provides the corresponding TypeScript type mappings
 * so apps get full type-checking against upstream package types.
 */

// ── Reactivity ───────────────────────────────────────────────────────────────

// Solid's surface is split across four entry points, and `export * from` tells a
// reader nothing about which one holds what — `describeBundledLibrary("solid-js")`
// returned exactly these four lines, so an agent told to look a library up before
// writing against it learned only that the modules exist. Importing `render` or
// `html` from '@bundled/solid-js' is the single most common first-compile failure.
// The comments below are part of what that lookup returns; keep them accurate.

declare module '@bundled/solid-js' {
  // Reactivity and control flow ONLY. `render` and `html` are NOT here.
  //   createSignal, createEffect, createMemo, createResource, createComputed
  //   onMount, onCleanup, batch, untrack, on
  //   createContext, useContext, lazy, Suspense, ErrorBoundary
  //   For, Show, Index, Switch, Match, Portal(->/web), Dynamic(->/web)
  export * from 'solid-js';
}

declare module '@bundled/solid-js/html' {
  // The `html` tagged template — a DEFAULT export, so:
  //   import html from '@bundled/solid-js/html';
  // Not `import { html }`, and not from '@bundled/solid-js'.
  export { default } from 'solid-js/html';
}

declare module '@bundled/solid-js/web' {
  // DOM entry: render, hydrate, Portal, Dynamic, isServer, template.
  //   import { render } from '@bundled/solid-js/web';
  export * from 'solid-js/web';
}

declare module '@bundled/solid-js/store' {
  // Nested reactive stores: createStore, produce, reconcile, unwrap.
  export * from 'solid-js/store';
}

// CSS module imports
declare module '*.css' {}

// Static-asset imports — inlined as base64 `data:` URIs by the `dataurl` loaders
// in compile.ts (ASSET_LOADERS). Each default export is the data-URI string,
// usable directly in `<img src>`, CSS `url()`, `fetch()`, `new Audio()`, etc.
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.jpeg' {
  const src: string;
  export default src;
}
declare module '*.gif' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
declare module '*.webp' {
  const src: string;
  export default src;
}
declare module '*.avif' {
  const src: string;
  export default src;
}
declare module '*.ico' {
  const src: string;
  export default src;
}
declare module '*.woff' {
  const src: string;
  export default src;
}
declare module '*.woff2' {
  const src: string;
  export default src;
}
declare module '*.ttf' {
  const src: string;
  export default src;
}
declare module '*.otf' {
  const src: string;
  export default src;
}
declare module '*.wasm' {
  const src: string;
  export default src;
}
declare module '*.mp3' {
  const src: string;
  export default src;
}
declare module '*.wav' {
  const src: string;
  export default src;
}

// ── Utilities ───────────────────────────────────────────────────────────────

declare module '@bundled/uuid' {
  export * from 'uuid';
}

declare module '@bundled/lodash' {
  export * from 'lodash-es';
}

declare module '@bundled/date-fns' {
  export * from 'date-fns';
}

declare module '@bundled/clsx' {
  export * from 'clsx';
  export { default } from 'clsx';
}

// ── Animation ───────────────────────────────────────────────────────────────

declare module '@bundled/anime' {
  // animejs v4 — explicit allowlist of named exports (no default export).
  // Only v4 APIs listed here pass typecheck. v3 patterns (default import, anime()) are blocked.
  // Use: import { animate, createTimeline, stagger } from '@bundled/anime'
  export {
    // Core
    animate,
    stagger,
    createTimeline,
    createTimer,
    createSpring,
    createAnimatable,
    createDraggable,
    createScope,
    createLayout,
    onScroll,
    engine,
    // Namespaces
    easings,
    utils,
    svg,
    text,
    waapi,
    // Easing creators
    cubicBezier,
    steps,
    linear,
    irregular,
    spring,
    // Types (classes)
    Timer,
    JSAnimation,
    Timeline,
    Animatable,
    Draggable,
    Scope,
    ScrollObserver,
    Spring,
    AutoLayout,
    WAAPIAnimation,
    scrollContainers,
  } from 'animejs';
}

// ── 3D Graphics ─────────────────────────────────────────────────────────────

declare module '@bundled/three' {
  export * from 'three';
}

declare module '@bundled/cannon-es' {
  export * from 'cannon-es';
}

// ── 2D Graphics ─────────────────────────────────────────────────────────────

declare module '@bundled/konva' {
  export { default } from 'konva';
  export { default as Konva } from 'konva';
}

declare module '@bundled/pixi.js' {
  export * from 'pixi.js';
}

declare module '@bundled/p5' {
  export { default } from 'p5';
  export { default as p5 } from 'p5';
}

// ── Physics ─────────────────────────────────────────────────────────────────

declare module '@bundled/matter-js' {
  import Matter from 'matter-js';
  export = Matter;
}

// ── Data Visualization ──────────────────────────────────────────────────────

declare module '@bundled/chart.js' {
  export * from 'chart.js';
}

declare module '@bundled/d3' {
  export * from 'd3';
}

// ── Diff ───────────────────────────────────────────────────────────────────

declare module '@bundled/diff' {
  export * from 'diff';
}

declare module '@bundled/diff2html' {
  export * from 'diff2html';
}

// ── Documents & Code ────────────────────────────────────────────────────────

declare module '@bundled/xlsx' {
  export * from '@e965/xlsx';
}

declare module '@bundled/marked' {
  export * from 'marked';
}

declare module '@bundled/mammoth' {
  import mammoth from 'mammoth';
  export = mammoth;
}

// Diagrams from text: `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`,
// `erDiagram`, `journey`, `gantt`, `pie`, `mindmap`, `timeline`, `gitGraph`, `quadrantChart`,
// `sankey-beta`, `xychart-beta`, `block-beta`, `C4Context`, `architecture-beta`.
//
// Prefer `renderMermaid(source)` over the default export: it applies the YAAR design
// tokens, forces the strict security level, and serializes renders against mermaid's
// global config. The SVG it returns is ALREADY SANITIZED — do not pass it through
// `sanitizeHtml` from '@bundled/yaar', which strips the `<style>` block the diagram
// needs to theme itself.
//
// Rendering is async and needs a live document (it measures text), so render after
// mount, not during it. Insert the result with `element.innerHTML = svg`.
declare module '@bundled/mermaid' {
  import mermaid from 'mermaid';

  export type { MermaidConfig, RenderResult } from 'mermaid';

  /**
   * Palette for one diagram, in YAAR's vocabulary rather than mermaid's ~140
   * `themeVariables`. Anything omitted falls back to the design token of the
   * same role, so most callers pass nothing at all.
   */
  export interface MermaidThemeInput {
    /** Diagram canvas behind everything. Default `--yaar-bg`. */
    background?: string;
    /** Node/box fill. Default `--yaar-bg-surface`. */
    surface?: string;
    /** Label and title text. Default `--yaar-text`. */
    text?: string;
    /** Edges, arrowheads, and secondary text. Default `--yaar-text-muted`. */
    muted?: string;
    /** Node borders and emphasis. Default `--yaar-accent`. */
    accent?: string;
    /** Cluster/subgraph borders. Default `--yaar-border`. */
    border?: string;
    /** Default `--yaar-font`. */
    fontFamily?: string;
    /** CSS length, e.g. `'16px'`. Default `--yaar-text-base`. */
    fontSize?: string;
  }

  export interface RenderMermaidOptions {
    /** Per-diagram palette overrides; see `MermaidThemeInput`. */
    theme?: MermaidThemeInput;
    /** `'handDrawn'` gives the rough.js sketch look. Default `'classic'`. */
    look?: 'classic' | 'handDrawn';
    /**
     * DOM id mermaid renders under. Defaults to a fresh unique id. Pass one only
     * to make a render reproducible — two live diagrams sharing an id collide,
     * because mermaid scopes the SVG's `<style>` rules by it.
     */
    id?: string;
  }

  /**
   * Render mermaid source to a sanitized `<svg>` string.
   *
   * Rejects on a syntax error instead of returning mermaid's "Syntax error in
   * text" diagram, so the caller decides what an invalid diagram looks like.
   *
   * ```ts
   * const svg = await renderMermaid('flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]');
   * host.innerHTML = svg;
   * ```
   */
  export function renderMermaid(source: string, options?: RenderMermaidOptions): Promise<string>;

  /**
   * Whether the source parses, without rendering it. For an editor marking a
   * diagram invalid while it is being typed — cheaper than a full render, and it
   * never touches the document.
   */
  export function isValidMermaid(source: string): Promise<boolean>;

  /**
   * The upstream mermaid API, for config the helpers above do not cover. Calling
   * `initialize()` yourself replaces the security level and theme for every later
   * `renderMermaid` call too, because mermaid's config is global.
   */
  export default mermaid;
}

declare module '@bundled/prismjs' {
  export * from 'prismjs';
}

declare module '@bundled/dompurify' {
  export * from 'dompurify';
  export { default } from 'dompurify';
}

// ── Validation ──────────────────────────────────────────────────────────────

// Zod Mini — the tree-shakeable functional API. Standard Zod's `z` namespace pulls
// ~260KB into every consuming app because it defeats bundler tree-shaking; Mini's
// per-validator functions bundle to ~10KB. Functional API: `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. See https://zod.dev/packages/mini
declare module '@bundled/zod' {
  export * from 'zod/mini';
}

// ── Audio ───────────────────────────────────────────────────────────────────

declare module '@bundled/tone' {
  export * from 'tone';
}

// ── YAAR SDK ────────────────────────────────────────────────────────────────

// -- App Protocol --

/** Second argument every command `run` receives (see `YaarAppCommandDefinition.run`). */
interface YaarAppCommandContext {
  /**
   * True when the server is replaying a command recorded before the iframe
   * remounted, rather than delivering a fresh call. A handler that wants
   * replay-aware behaviour reads this; one that is simply not replayable
   * declares `replay: 'never'` instead.
   */
  replayed: boolean;
}

interface YaarAppEventDescriptor {
  /** Human-readable description of when this channel fires (shown to the agent). */
  description: string;
}

// -- JSON Schema → TypeScript inference (used by defineApp/defineAppCommand) --

/**
 * Structural constraint for a `params` / `schema` JSON Schema literal.
 * The index signature keeps unknown keywords (`default`, `examples`, ...) legal.
 */
interface YaarJsonSchema {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  properties?: Record<string, unknown>;
  required?: readonly string[];
  items?: unknown;
  additionalProperties?: unknown;
  [keyword: string]: unknown;
}

/** Collapse an intersection into a single object type so hovers stay readable. */
type YaarFlatten<T> = { [K in keyof T]: T[K] } & {};

/** The union of a schema's `required` entries, or `never` when it declares none. */
type YaarRequiredKeys<S> = S extends { required: readonly (infer R)[] }
  ? R extends string
    ? R
    : never
  : never;

/**
 * Map a schema's `properties` to an object type, honouring `required`.
 *
 * With no `properties`, fall back to `additionalProperties` — the idiomatic way to
 * describe a dictionary (`{ type: 'object', additionalProperties: { type: 'string' } }`
 * → `Record<string, string>`). A bare `{ type: 'object' }` stays `Record<string, unknown>`.
 */
type YaarInferObject<S> = S extends { properties: infer P }
  ? YaarFlatten<
      {
        [K in keyof P as K extends YaarRequiredKeys<S> ? K : never]: YaarInferSchema<P[K]>;
      } & {
        [K in keyof P as K extends YaarRequiredKeys<S> ? never : K]?: YaarInferSchema<P[K]>;
      }
    >
  : S extends { additionalProperties: infer A }
    ? A extends true
      ? Record<string, unknown>
      : A extends false
        ? Record<string, never>
        : Record<string, YaarInferSchema<A>>
    : Record<string, unknown>;

/**
 * Translate a JSON Schema literal into the TypeScript type it describes.
 *
 * Covers the keywords app protocols actually use: `enum`, the six primitive
 * `type`s, `array` + `items`, and `object` + `properties`/`required` (nested).
 * Anything else — `anyOf`, `oneOf`, `$ref` — falls back to `unknown`, which
 * surfaces as a type error in the handler rather than a wrong type. Annotate
 * that handler's parameter explicitly, or keep the plain-object descriptor.
 */
type YaarInferSchema<S> = S extends { enum: readonly (infer E)[] }
  ? E
  : S extends { type: 'string' }
    ? string
    : S extends { type: 'number' | 'integer' }
      ? number
      : S extends { type: 'boolean' }
        ? boolean
        : S extends { type: 'null' }
          ? null
          : S extends { type: 'array' }
            ? S extends { items: infer I }
              ? YaarInferSchema<I>[]
              : unknown[]
            : S extends { type: 'object' }
              ? YaarInferObject<S>
              : unknown;

// -- defineApp() authoring shape --

/**
 * One entry of `defineApp({ state })`. The reader is a getter, not a request
 * handler, hence `get` rather than the `handler` the wire-level descriptor uses.
 */
interface YaarAppStateDefinition<T = unknown> {
  description: string;
  /** Optional schema for the value, exported to the agent-facing manifest. */
  schema?: object;
  get: () => T | Promise<T>;
}

/**
 * The non-inferred shape of one `defineApp({ commands })` entry — what a command
 * looks like when you are annotating a map by hand rather than letting
 * `defineApp` derive `run`'s parameter from `params`.
 */
interface YaarAppCommandDefinition<P = Record<string, unknown>, R = unknown> {
  description: string;
  aliases?: readonly string[];
  /** JSON Schema literal for the parameters. Extracted into the manifest verbatim. */
  params?: object;
  returns?: object;
  /**
   * Replay policy for this command. `'always'` (the default) re-runs it when the
   * iframe remounts, which is right for state restoration (`navigate`, `setDeck`).
   * `'never'` skips it, for a command that appends, notifies, or is otherwise
   * one-shot. The list of `'never'` commands rides the ready handshake.
   */
  replay?: 'always' | 'never';
  run: (params: P, ctx: YaarAppCommandContext) => R | Promise<R>;
}

/**
 * The type a Standard Schema produces — Zod v4, Valibot, ArkType.
 *
 * `never` when `S` is not one, which is how `YaarAppRunParams` chooses between
 * the two schema dialects without a second type parameter.
 */
type YaarStandardOutput<S> = S extends { '~standard': { types?: { output: infer O } | undefined } }
  ? O
  : never;

/**
 * What a `run` receives as its first argument.
 *
 * Three cases, in order: a Zod (or other Standard Schema) `params` gives the type
 * it *parses to* — `run` is handed the parsed value, so defaults and transforms
 * have already been applied; a JSON Schema literal is translated by
 * `YaarInferSchema`; and a command with no schema at all gets a free-form bag,
 * because `S` is then `unknown` and every property access would otherwise error.
 */
type YaarAppRunParams<S> = unknown extends S
  ? Record<string, unknown>
  : [YaarStandardOutput<S>] extends [never]
    ? YaarInferSchema<S>
    : YaarStandardOutput<S>;

/**
 * The `commands` map, keyed by a *schema* map `S` rather than by the commands
 * themselves. Each `S[K]` is inferred from that command's `params` literal — a
 * plain inference site, unlike `run`, which is context-sensitive — and `run`'s
 * parameter is then derived from it with the same engine `defineAppCommand` uses.
 * One schema, written once, types the handler and feeds the manifest.
 *
 * Keying on the schemas is what makes this work. The natural spelling — a
 * self-referential constraint (`C extends YaarAppCommands<C>`) over the command
 * map — type-checks but infers nothing useful: `C` is resolved before the `const`
 * modifier narrows `params` to its literal, so every `run` parameter degrades to
 * `unknown`, silently. The failure is invisible (no error, just weaker types), so
 * `define-app.test.ts` asserts on a misspelled key being *rejected*.
 */
/**
 * One command as `defineAppCommand` sees it: the same entry shape as
 * `YaarAppCommands<S>[K]`, with the schema as a standalone parameter so a
 * descriptor declared outside the `defineApp({...})` literal still types its own
 * `run`. `R` is preserved so the wrapper returns the descriptor unwidened.
 */
interface YaarAppCommandOf<S, R> {
  description: string;
  aliases?: readonly string[];
  params?: S;
  returns?: object;
  /** See `YaarAppCommandDefinition.replay`. */
  replay?: 'always' | 'never';
  run: (params: YaarAppRunParams<S>, ctx: YaarAppCommandContext) => R | Promise<R>;
}

type YaarAppCommands<S> = {
  [K in keyof S]: {
    description: string;
    aliases?: readonly string[];
    /**
     * The parameter contract: a Zod schema (preferred — it also validates the
     * call) or a JSON Schema literal. Either way the build folds it into the
     * agent-facing manifest, and `run`'s parameter is derived from it.
     */
    params?: S[K];
    returns?: object;
    /** See `YaarAppCommandDefinition.replay`. */
    replay?: 'always' | 'never';
    run: (params: YaarAppRunParams<S[K]>, ctx: YaarAppCommandContext) => unknown;
  };
};

/**
 * The imperative escape hatch for `view`. An app that owns its own DOM (a
 * spreadsheet grid, a canvas editor) hands `defineApp` a `mount` instead of a
 * Solid component; the returned function, if any, is torn down on window close.
 */
interface YaarAppView {
  mount(el: HTMLElement): void | (() => void);
}

/** A Solid component (called with no props) or the imperative `{ mount }` form. */
type YaarAppViewLike = YaarAppView | (() => unknown);

/**
 * The object passed to (and returned by) `defineApp`.
 *
 * `S` is the map of per-command `params` schemas and `St` the state map; both are
 * inferred from the call, so the returned definition keeps the caller's literal
 * types. The defaults are the hand-annotation fallback (`params` unconstrained,
 * `run` taking a free-form bag), not what a real `defineApp(...)` call resolves to.
 */
interface YaarAppDefinition<
  S = Record<string, unknown>,
  St = Record<string, YaarAppStateDefinition>,
> {
  /** Must equal the `id` in this app's `app.json`; the build enforces it. */
  id: string;
  name: string;
  state?: St;
  commands?: YaarAppCommands<S>;
  /** Channels this app may `app.emit()` on. */
  events?: Record<string, YaarAppEventDescriptor>;
  /**
   * Declarative keyboard shortcuts: combo → declared command name, e.g.
   * `{ ArrowRight: 'nextPage', 'Ctrl+s': 'save' }`. Modifiers: Ctrl/Meta/Alt/
   * Shift (Ctrl also matches Cmd); the key part is a `KeyboardEvent.key` name,
   * case-insensitive. The bound command runs with no params, so its `params`
   * must be absent or all-optional. Combos without Ctrl/Meta/Alt are suppressed
   * while an editable element has focus. The shell's own combos (Shift+Tab,
   * Ctrl+1-9, Ctrl+W, Ctrl+R, F5) are reserved — the build rejects them.
   */
  keybindings?: Record<string, string>;
  view?: YaarAppViewLike;
  /** Fire-and-forget callback invoked when the app window is closed. */
  onClose?: () => void;
  /**
   * Custom capture handler. When the OS captures this window (e.g. an agent
   * reads it), the returned data-URL image (`data:image/...`) is used instead
   * of the default window screenshot. Return null/undefined to fall back to
   * the default DOM+canvas composite capture. May be async.
   */
  onCapture?: () => string | null | undefined | Promise<string | null | undefined>;
}

interface YaarApp {
  sendInteraction(
    description:
      | string
      | (Record<string, unknown> & { instructions?: string; toMonitor?: boolean }),
  ): void;
  /**
   * Emit a fire-and-forget event on a declared channel. Delivered only to
   * agents that subscribed to this channel (undeclared channels are dropped).
   */
  emit(channel: string, payload?: unknown): void;
}

// -- Storage SDK --

interface YaarStorageReadOptions {
  as?: 'text' | 'json' | 'blob' | 'arraybuffer' | 'auto';
}

interface YaarStorage {
  save(path: string, data: string | Blob | ArrayBuffer | Uint8Array): Promise<{ ok: boolean }>;
  read(path: string, options?: YaarStorageReadOptions): Promise<unknown>;
  list(dirPath?: string): Promise<string[]>;
  remove(path: string): Promise<{ ok: boolean }>;
  url(path: string): string;
}

// -- App-scoped Storage SDK --

interface YaarAppStorageSaveOptions {
  encoding?: 'utf-8' | 'base64';
}

interface YaarAppStorageTrySaveOptions extends YaarAppStorageSaveOptions {
  /** Name shown in the failure toast. Defaults to `path`. */
  label?: string;
  /** Replaces the failure toast. Failures are logged either way. */
  onError?: (message: string, error: unknown) => void;
}

interface YaarAppStorageEntry {
  path: string;
  isDirectory: boolean;
  uri: string;
  mimeType?: string;
}

interface YaarAppStorage {
  save(path: string, content: string, options?: YaarAppStorageSaveOptions): Promise<void>;
  /**
   * `save()` that reports failure instead of throwing. Resolves to whether the
   * write landed, so callers can hold back a "Saved" toast or a dirty-flag clear.
   * Failures are logged, and toasted at most once per 5s per path.
   */
  trySave(path: string, content: string, options?: YaarAppStorageTrySaveOptions): Promise<boolean>;
  read(path: string): Promise<string>;
  readJson<T = unknown>(path: string): Promise<T>;
  /** Read JSON with a fallback value returned when the file doesn't exist or is unparseable. */
  readJsonOr<T>(path: string, fallback: T): Promise<T>;
  readBinary(
    path: string,
  ): Promise<{ data: string; mimeType: string; encoding: 'base64' | 'text' }>;
  /** Read binary data and return as a Blob. Handles the base64 → binary conversion. */
  readBlob(path: string): Promise<Blob>;
  list(dirPath?: string): Promise<YaarAppStorageEntry[]>;
  remove(path: string): Promise<void>;
}

// -- App-scoped database (SQLite collections) --

/** Meta fields the server adds to every stored document. */
interface YaarDbMeta {
  _id: string;
  _created_at: string;
  _updated_at: string;
}

/**
 * Mongo-style filter: exact match `{ status: 'active' }`, operators
 * `{ age: { $gt: 18 } }` ($gt/$gte/$lt/$lte/$ne/$in/$exists), array contains
 * `{ tags: 'intro' }`. Multiple fields AND together.
 */
type YaarDbFilter = Record<string, unknown>;

interface YaarDbFindOptions {
  /** Sort spec, e.g. `{ _created_at: -1 }`. Ascending: 1, descending: -1. */
  sort?: Record<string, 1 | -1>;
  /** Max results (default 100, max 1000). */
  limit?: number;
  /** Skip N results (for pagination). */
  offset?: number;
}

interface YaarDbCollection<T extends object = Record<string, unknown>> {
  /** Insert a document. Returns the generated _id. */
  insert(doc: T): Promise<string>;
  /** Insert many documents in one transaction. Returns generated ids. */
  insertMany(docs: T[]): Promise<string[]>;
  /** Fetch one document by _id, or null if it doesn't exist. */
  get(id: string): Promise<(T & YaarDbMeta) | null>;
  /** Query documents matching the filter (all documents when omitted). */
  find(filter?: YaarDbFilter, options?: YaarDbFindOptions): Promise<(T & YaarDbMeta)[]>;
  /** Full-text search across all document fields, best matches first. */
  search(query: string, limit?: number): Promise<(T & YaarDbMeta)[]>;
  /** Shallow-merge patch into the stored document. */
  update(id: string, patch: Partial<T>): Promise<void>;
  /** Delete one document by _id. */
  remove(id: string): Promise<void>;
  /** Delete all documents matching a non-empty filter. Returns deleted count. */
  removeWhere(filter: YaarDbFilter): Promise<number>;
  /** Count documents matching the filter (all documents when omitted). */
  count(filter?: YaarDbFilter): Promise<number>;
}

interface YaarDbReactiveHelpers<T extends object> {
  insert(doc: T): Promise<string>;
  update(id: string, patch: Partial<T>): Promise<void>;
  remove(id: string): Promise<void>;
  /** Re-run the query and update the signal. */
  refresh(): Promise<void>;
  /** Stop refreshing and drop the change subscription (auto on Solid cleanup). */
  dispose(): void;
}

interface YaarAppDb {
  /** Get a collection handle (lazy — no network call until used). */
  collection<T extends object = Record<string, unknown>>(name: string): YaarDbCollection<T>;
  /** List collection names in this app's database. */
  collections(): Promise<string[]>;
  /** Drop a collection and all its documents. */
  drop(name: string): Promise<void>;
  /**
   * Reactive Solid.js binding for a collection query: `docs()` is a signal
   * holding the current results; helper mutations refresh it, and external
   * changes arrive via a verb subscription.
   */
  createReactiveCollection<T extends object = Record<string, unknown>>(
    name: string,
    options?: YaarDbFindOptions & { filter?: YaarDbFilter },
  ): [() => (T & YaarDbMeta)[], YaarDbReactiveHelpers<T>];
}

// -- Notifications SDK --

interface YaarNotificationItem {
  id: string;
  title?: string;
  body?: string;
  [key: string]: unknown;
}

interface YaarNotifications {
  list(): YaarNotificationItem[];
  count(): number;
  onChange(callback: (items: YaarNotificationItem[]) => void): () => void;
}

// -- Windows SDK --

interface YaarWindowReadOptions {
  includeImage?: boolean;
}

interface YaarWindowReadResult {
  id: string;
  title: string;
  renderer: string;
  content: unknown;
  imageData?: string;
}

interface YaarWindowListItem {
  id: string;
  title: string;
  renderer: string;
}

interface YaarWindows {
  read(windowId: string, options?: YaarWindowReadOptions): Promise<YaarWindowReadResult>;
  list(): Promise<YaarWindowListItem[]>;
}

// -- Dev Tools --

interface YaarDevCompileResult {
  success: boolean;
  previewUrl?: string;
  errors?: string[];
  /** Extracted manifest key names — null when the app registers no protocol. */
  protocol?: { commands: string[]; state: string[] } | null;
  /** Set on transport/auth failures (4xx/5xx) instead of the compile-result fields. */
  error?: string;
}

interface YaarDevTypecheckResult {
  success: boolean;
  diagnostics: string[];
  /** Set on transport/auth failures (4xx/5xx) instead of the typecheck-result fields. */
  error?: string;
}

interface YaarDevDeployOpts {
  appId: string;
  name?: string;
  icon?: string;
  description?: string;
  permissions?: string[];
  /** Commit message for the history snapshot this deploy records. */
  message?: string;
  /**
   * Ship without type checking. Deploy type checks first and refuses on errors —
   * this states you know, and want it anyway.
   */
  skipTypecheck?: boolean;
  /**
   * Ship a manifest that drops commands the installed app currently has. Deploy
   * compares protocols first and refuses shrink — this states you know, and
   * want it anyway.
   */
  allowProtocolShrink?: boolean;
}

interface YaarDevDeployResult {
  success: boolean;
  appId?: string;
  name?: string;
  icon?: string;
  error?: string;
  /** Present when the deploy was refused by the protocol shrink gate. Counts are commands. */
  protocolShrink?: { before: number; after: number; missing: string[] };
  /**
   * Windows of the deployed app that were closed because they were still running the
   * previous build. The deploying window itself is never among them.
   */
  closedWindows?: string[];
}

/** A commit in an app's version history. */
interface YaarDevCommit {
  hash: string;
  shortHash: string;
  /** Unix ms. */
  timestamp: number;
  message: string;
}

interface YaarDevHistoryResult {
  success: boolean;
  commits?: YaarDevCommit[];
  error?: string;
}

interface YaarDevDiffOpts {
  /** Commit to diff against. A hash or `HEAD~N`. Defaults to `HEAD`. Snapshot base only. */
  ref?: string;
  /**
   * `snapshot` (default) — diff against the app's own history ("what changed
   * since the last deploy"). `repo` — diff against the user's git repo ("what
   * has this app changed relative to what the user committed"); bundled apps only.
   */
  against?: 'snapshot' | 'repo';
}

interface YaarDevDiffResult {
  success: boolean;
  /** Unified diff. Empty when there are no changes. */
  diff?: string;
  /** Paths touched, relative to the app directory. */
  files?: string[];
  against?: 'snapshot' | 'repo';
  ref?: string;
  /** True when the diff was clipped to stay under the size cap. */
  truncated?: boolean;
  error?: string;
}

interface YaarDevRestoreResult {
  success: boolean;
  appId?: string;
  /** The commit that was restored, fully resolved. */
  ref?: string;
  files?: string[];
  /** Whether dist/ was rebuilt from the restored source. */
  recompiled?: boolean;
  /** Set when the source restored but recompiling it failed. */
  compileError?: string;
  error?: string;
}

interface YaarDev {
  compile(path: string, opts?: { title?: string }): Promise<YaarDevCompileResult>;
  typecheck(path: string): Promise<YaarDevTypecheckResult>;
  deploy(path: string, opts: YaarDevDeployOpts): Promise<YaarDevDeployResult>;
  bundledLibraries(): Promise<string[]>;
  gitHistory(appId?: string, opts?: { limit?: number }): Promise<YaarDevHistoryResult>;
  gitDiff(appId?: string, opts?: YaarDevDiffOpts): Promise<YaarDevDiffResult>;
  gitRestore(appId: string, ref: string): Promise<YaarDevRestoreResult>;
  gitCheckpoint(appId?: string, opts?: { message?: string }): Promise<YaarDevHistoryResult>;
}

// -- Global --

interface YaarGlobal {
  app: YaarApp;
  storage: YaarStorage;
  notifications: YaarNotifications;
  windows: YaarWindows;

  /** Execute an action on a yaar:// resource. Returns parsed data from the JSON envelope. */
  invoke<T = unknown>(uri: string, payload?: Record<string, unknown>): Promise<T>;
  /** Read the current value/state of a yaar:// resource. Returns parsed data. */
  read<T = unknown>(uri: string): Promise<T>;
  /** List child resources under a yaar:// URI. Returns parsed data. */
  list<T = unknown>(uri: string): Promise<T>;
  /** Describe a yaar:// resource (supported verbs, schema). Returns parsed data. */
  describe<T = unknown>(uri: string): Promise<T>;
  /** Delete a yaar:// resource. Returns parsed data. */
  delete<T = unknown>(uri: string): Promise<T>;
}

interface Window {
  yaar?: YaarGlobal;
}

// -- @bundled/yaar module --

declare module '@bundled/yaar' {
  /** Read the current value/state of a yaar:// resource. */
  export function read<T = unknown>(uri: string): Promise<T>;
  /** Execute an action on a yaar:// resource. */
  export function invoke<T = unknown>(uri: string, payload?: Record<string, unknown>): Promise<T>;
  /** List child resources under a yaar:// URI. */
  export function list<T = unknown>(uri: string): Promise<T>;
  /** Describe a yaar:// resource (supported verbs, schema). */
  export function describe<T = unknown>(uri: string): Promise<T>;
  /** Delete a yaar:// resource. */
  export function del(uri: string): Promise<unknown>;
  /** Subscribe to reactive URI updates. */
  export function subscribe(uri: string, callback: (uri: string) => void): Promise<() => void>;
  /**
   * Make an HTTP request. The canonical app HTTP contract.
   *
   * Cross-origin calls go through YAAR's proxy (SSRF protection, domain allowlist,
   * 10 MB cap, 30s timeout, per-app cookie jar) and require `yaar://http` in
   * app.json. Same-origin calls behave like normal fetch. Both return a standard
   * `Response`. Prefer this over `invoke('yaar://http', …)`.
   */
  export function httpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /**
   * One frame of a stream subscription. `seq` is monotonic per subscription — a
   * gap means frames were dropped; `kind` is source-defined.
   */
  export interface StreamFrame {
    uri: string;
    seq: number;
    kind: string;
    data: unknown;
    ts: number;
  }
  /**
   * Stream a yaar:// URI: like `subscribe`, but the server pushes typed frames with
   * payloads instead of bare change pings. `opts.kinds` narrows delivery to the
   * listed frame kinds. Returns an unsubscribe thunk.
   */
  export function stream(
    uri: string,
    onFrame: (frame: StreamFrame) => void,
    opts?: { kinds?: string[] },
  ): Promise<() => void>;

  /** App-scoped storage (wraps yaar://apps/self/storage/ verbs). */
  export const appStorage: YaarAppStorage;

  /**
   * App-scoped SQLite database (wraps yaar://apps/self/db/ verbs).
   * Structured collections with Mongo-style filters and full-text search.
   * Granted to every app automatically — no app.json permission entry needed.
   */
  export const appDb: YaarAppDb;

  /** Re-exported sub-objects from window.yaar. */
  export const storage: YaarStorage;
  export const app: YaarApp;
  export const notifications: YaarNotifications;
  export const windows: YaarWindows;

  /**
   * The event-channel shape for `defineApp({ events })`, for hand-annotating a
   * map declared outside the call.
   */
  export type AppEventDescriptor = YaarAppEventDescriptor;

  /**
   * Register an app and mount its view — the one entrypoint, and the shape the
   * build reads.
   *
   * ```ts
   * import * as z from '@bundled/zod';
   *
   * export default defineApp({
   *   id: 'memo',                    // must equal app.json's id
   *   name: 'Memo',
   *   state: {
   *     memoCount: { description: 'Number of saved memos', get: () => memos().length },
   *   },
   *   commands: {
   *     addMemo: {
   *       description: 'Create a memo',
   *       params: z.object({ text: z.string() }),   // or a JSON Schema literal
   *       replay: 'never',           // this one appends; do not re-run it on remount
   *       run: async (p) => ({ id: await createMemo(p.text) }),   // `p.text` is a string
   *     },
   *   },
   *   view: App,                     // Solid component, or { mount(el) } for imperative apps
   * });
   * ```
   *
   * What it owns, so no app has to decide it again:
   *
   * - **Registration timing** — once, at module scope, before the view mounts.
   *   Registering from `onMount` or a component body re-registers on every
   *   remount; this cannot.
   * - **Mounting** — `render(view, #app)`, or `view.mount(#app)`. A `mount` that
   *   returns a teardown gets it called on window close, after `onClose`.
   * - **The error contract** — anything `run` throws reaches the agent as an
   *   `AppCommandError` with the original kept as `cause`.
   * - **`run`'s parameter type** — derived from that command's `params` schema,
   *   exactly as `defineAppCommand` does it for a descriptor declared elsewhere.
   * - **Parameter validation** — a Zod `params` is parsed before `run` sees it,
   *   so a wrong *type* is rejected by name instead of failing somewhere inside
   *   the handler. A JSON Schema literal is still only checked for presence and
   *   unknown keys, which is the reason to prefer Zod.
   *
   * `run` also receives `ctx.replayed`; `replay: 'never'` opts a command out of
   * replay entirely. Returns the definition unchanged, so
   * `export default defineApp({...})` stays readable by the build.
   */
  export function defineApp<
    const S,
    const St extends Record<string, YaarAppStateDefinition> = Record<
      string,
      YaarAppStateDefinition
    >,
  >(definition: YaarAppDefinition<S, St>): YaarAppDefinition<S, St>;

  /** The authoring shapes `defineApp` accepts, for hand-annotating a map. */
  export type AppDefinition<
    S = Record<string, unknown>,
    St = Record<string, YaarAppStateDefinition>,
  > = YaarAppDefinition<S, St>;
  export type AppStateDefinition<T = unknown> = YaarAppStateDefinition<T>;
  export type AppCommandDefinition<
    P = Record<string, unknown>,
    R = unknown,
  > = YaarAppCommandDefinition<P, R>;
  /** The `{ replayed }` object every `run` receives as its second argument. */
  export type AppCommandContext = YaarAppCommandContext;
  /** The imperative `view` form: `{ mount(el) { ... } }`. */
  export type AppView = YaarAppView;

  /**
   * Declare a command outside the `defineApp({...})` literal, keeping the
   * `params` schema typing its own `run`.
   *
   * `defineApp` infers each `run`'s parameter from the `params` written *at the
   * call site*. A command declared in another module and spread into
   * `defineApp({ commands: { ...fileCommands } })` is still extracted into the
   * manifest, but its `run` parameter degrades to `Record<string, unknown>` —
   * silently, since a wider type is not an error. Wrap the descriptor to keep
   * the schema typing its own handler:
   *
   * ```ts
   * // src/protocol/files.ts
   * export const fileCommands = {
   *   editFile: defineAppCommand({
   *     description: 'Replace a file's contents',
   *     params: z.object({ path: z.string(), content: z.string() }),
   *     run: (p) => write(p.path, p.content),   // `p` is typed here, not at the spread
   *   }),
   * };
   * ```
   *
   * Accepts a Zod `params` as well as a JSON Schema literal. Identity at
   * runtime; the extractor treats it as transparent by name, so keep the call
   * shape literal — a single identifier wrapping the descriptor object.
   */
  export function defineAppCommand<const S, R>(
    descriptor: YaarAppCommandOf<S, R>,
  ): YaarAppCommandOf<S, R>;

  /**
   * Create a set-once holder for the runtime context a protocol's handlers need.
   *
   * Descriptor maps must be top-level `const`s for the protocol extractor to
   * read them, so they cannot close over a `registerProtocol(ctx)` parameter,
   * and a `buildCommands(ctx)` factory is a call result the extractor refuses.
   * This is the supported seam: descriptors stay static, the context is
   * installed at registration time, and handlers read it via the accessor.
   *
   * ```ts
   * export const { set: setProtocolContext, get: ctx } =
   *   createProtocolContext<ProtocolContext>('slides-lite');
   * ```
   *
   * `get()` throws if read before `set()`. `set()` throws if called twice with
   * a different context — the holder is module state, so a second registration
   * would otherwise silently retarget the first one's handlers.
   */
  export function createProtocolContext<T>(label: string): {
    set(value: T): void;
    get(): T;
  };

  /** Returns a promise that resolves after `ms` milliseconds. */
  export function wait(ms: number): Promise<void>;

  /** Extract a human-readable message from any thrown value. */
  export function errMsg(e: unknown): string;

  /**
   * Throw from a command handler to signal failure to the agent.
   * The message is delivered as-is — no stack trace, no noise.
   */
  export class AppCommandError extends Error {
    constructor(message: string);
  }

  /** Show a toast notification using the built-in `y-toast` CSS classes. Auto-dismisses after `ms` (default 3000). */
  export function showToast(msg: string, type?: 'info' | 'success' | 'error', ms?: number): void;

  /** Options for the modal dialog helpers (showAlert / showConfirm / showPrompt). */
  export interface DialogOptions {
    /** Bold heading above the message. */
    title?: string;
    /** Label for the confirming button (default "OK"). */
    okLabel?: string;
    /** Label for the cancel button (default "Cancel"). */
    cancelLabel?: string;
    /** Style the confirming button as destructive (`y-btn-danger`). */
    danger?: boolean;
  }

  /**
   * Show a modal alert styled with the built-in `y-modal` classes. Resolves when
   * dismissed. Use instead of native `alert()`, which blocks the whole page.
   */
  export function showAlert(
    msg: string,
    opts?: Pick<DialogOptions, 'title' | 'okLabel'>,
  ): Promise<void>;

  /**
   * Show a modal confirm dialog. Resolves `true` on OK, `false` on
   * Cancel/Escape/backdrop click. Use instead of native `confirm()`.
   * Pass `danger: true` for destructive actions.
   */
  export function showConfirm(msg: string, opts?: DialogOptions): Promise<boolean>;

  /**
   * Show a modal prompt with a text input. Resolves the entered string on OK,
   * or `null` on Cancel/Escape. Use instead of native `prompt()`.
   */
  export function showPrompt(
    msg: string,
    opts?: DialogOptions & { placeholder?: string; initial?: string },
  ): Promise<string | null>;

  /**
   * Run an async function with loading/error state management.
   * Sets loading to true, runs fn, catches errors via onError, and clears loading in finally.
   */
  export function withLoading<T>(
    setLoading: (v: boolean) => void,
    fn: () => Promise<T>,
    onError?: (msg: string) => void,
  ): Promise<T | undefined>;

  /**
   * The generation counter that keeps a slow response from overwriting a newer one.
   *
   * ```ts
   * const guard = createStaleGuard();
   * const fresh = guard.begin();   // supersedes anything in flight
   * const post = await fetchPost(id);
   * if (!fresh()) return;          // a newer load started; drop this one
   * ```
   *
   * `latest()` joins the current generation without superseding it (a secondary
   * fetch that must be cancelled by the next `begin()` but must not cancel its
   * siblings). `invalidate()` bumps with no fetch attached, dropping everything
   * in flight.
   */
  export function createStaleGuard(): {
    begin(): () => boolean;
    latest(): () => boolean;
    invalidate(): void;
  };

  export interface SanitizeHtmlOptions {
    /** Restrict to an explicit tag allowlist (DOMPurify `ALLOWED_TAGS`). */
    allowedTags?: string[];
    /** Restrict to an explicit attribute allowlist (DOMPurify `ALLOWED_ATTR`). */
    allowedAttr?: string[];
    /**
     * Extra tags to forbid. Added to the form-control default — except when
     * `allowedTags` is given, in which case the allowlist is the whole policy
     * and this list is the only subtraction from it.
     */
    forbidTags?: string[];
    /** Attributes to forbid (DOMPurify `FORBID_ATTR`). */
    forbidAttr?: string[];
  }

  /**
   * Sanitize untrusted HTML for insertion into an app iframe. Use this rather
   * than calling DOMPurify directly.
   *
   * DOMPurify's own defaults (scripts, event handlers, and `javascript:`/`data:`
   * URLs already stripped) plus the deviation every YAAR app makes: `form` and
   * its controls are forbidden, since no foreign content YAAR renders has a
   * legitimate reason to post, and a form inside the iframe can navigate it or
   * phish against the app's chrome. That correction applies to DOMPurify's
   * default allowlist; pass `allowedTags` and your list is the whole policy.
   *
   * Call order is always parse -> sanitize the whole fragment -> rewrite ->
   * insert. Relative URLs survive verbatim; an app that needs them resolved
   * rewrites the *sanitized* output.
   */
  export function sanitizeHtml(html: string, opts?: SanitizeHtmlOptions): string;

  /**
   * Register a keyboard shortcut. Returns a cleanup function.
   *
   * Combo format: modifier keys joined with `+`, e.g. `"ctrl+s"`, `"alt+arrowup"`, `"escape"`.
   * `ctrl` matches both Ctrl and Cmd (Meta) for cross-platform shortcuts.
   */
  export function onShortcut(combo: string, handler: (e: KeyboardEvent) => void): () => void;

  /**
   * Create a Solid.js signal that auto-persists to appStorage.
   * The signal starts with `fallback` and updates once the stored value loads.
   * Saves to appStorage automatically on every change.
   *
   * A failed save is reported (logged, and toasted at most once per 5s) rather
   * than dropped. Pass `label` to name the data in that toast, or `onError` to
   * replace it.
   *
   * `revive` runs on the loaded value before it reaches the signal — clamp a
   * stale value, migrate a renamed key, or `z.safeParse` JSON a previous version
   * wrote in another shape. It also runs on `fallback` when nothing is stored,
   * so it must be total; if it throws, the fallback is used and it is logged.
   */
  export function createPersistedSignal<T>(
    key: string,
    fallback: T,
    options?: {
      label?: string;
      onError?: (message: string, error: unknown) => void;
      revive?: (raw: unknown) => T;
    },
  ): [get: () => T, set: (v: T | ((prev: T) => T)) => void];

  /**
   * The hover-expand + pin sidebar/overlay state machine.
   *
   * Visible when pinned or while the cursor is over the panel; a grace period
   * before the fold keeps a brief cursor exit from flickering it shut. Pin state
   * persists to appStorage when `pinKey` is given (with a touch-guard so a user
   * toggle beats the async load). `setResizing(true)` suppresses the auto-close
   * while a width handle is dragged. Headless — the app owns the markup.
   */
  export function createCollapsiblePanel(opts?: {
    pinKey?: string;
    closeDelayMs?: number;
    pinLabel?: string;
  }): {
    expanded: () => boolean;
    pinned: () => boolean;
    open(): void;
    scheduleClose(): void;
    close(): void;
    cancelClose(): void;
    togglePin(): void;
    setPin(v: boolean): void;
    setResizing(active: boolean): void;
  };

  /**
   * The dirty / debounced-save / save-status lifecycle for an autosaving document.
   *
   * Wraps `save` with a debounce, a `dirty`/`saveFailed`/`lastSavedAt` triad, and
   * an editSeq guard so a save that began before the latest edit does not clear
   * the dirty flag. `save` returns whether the write succeeded (`false` stays
   * dirty). `statusLabel()` yields "Saving…" | "Saved 14:22" | "Not saved".
   */
  export function createAutosave<T = void>(
    save: (value: T) => Promise<boolean>,
    opts?: { debounceMs?: number; onSaved?: () => void },
  ): {
    markDirty(value: T): void;
    flush(withToast?: boolean): Promise<void>;
    dirty: () => boolean;
    saveFailed: () => boolean;
    lastSavedAt: () => number;
    statusLabel: () => string;
  };

  /** The raw window.yaar global. */
  export const yaar: YaarGlobal;
  export default yaar;
}

// ── Gated SDKs ─────────────────────────────────────────────────────────────
// Require "bundles": ["yaar-dev"] or ["yaar-web"] in app.json to import.

declare module '@bundled/yaar-dev' {
  export function compile(path: string, opts?: { title?: string }): Promise<YaarDevCompileResult>;
  export function typecheck(path: string): Promise<YaarDevTypecheckResult>;
  export function deploy(path: string, opts: YaarDevDeployOpts): Promise<YaarDevDeployResult>;
  /** Get all available bundled library names. */
  export function bundledLibraries(): Promise<string[]>;
  /** Get detailed type information for a specific bundled library. */
  export function bundledLibraries(name: string): Promise<{ name: string; types: string }>;

  // -- Version history --
  // Every deploy is snapshotted into a per-app shadow git repo, so a bad deploy
  // is undoable. `appId` defaults to the calling app; naming another app
  // requires the caller to be a bundled app.

  /** Commits for an app, newest first. */
  export function gitHistory(
    appId?: string,
    opts?: { limit?: number },
  ): Promise<YaarDevHistoryResult>;
  /** Diff an app's current files against its history, or against the user's repo. */
  export function gitDiff(appId?: string, opts?: YaarDevDiffOpts): Promise<YaarDevDiffResult>;
  /**
   * Roll an app back to an earlier commit and rebuild it. The current state is
   * snapshotted first, so a restore is itself undoable.
   */
  export function gitRestore(appId: string, ref: string): Promise<YaarDevRestoreResult>;
  /** Snapshot an app's current state as a commit — e.g. before a risky change. */
  export function gitCheckpoint(
    appId?: string,
    opts?: { message?: string },
  ): Promise<YaarDevHistoryResult>;
}

declare module '@bundled/yaar-ml' {
  // In-browser model inference via onnxruntime-web (WebGPU EP + wasm fallback).
  // Requires "bundles": ["yaar-ml"] in app.json.

  export type Backend = 'webgpu' | 'wasm' | 'auto';

  /** A numeric type ORT tensors can hold. */
  export type MlTensorType =
    | 'float32'
    | 'float16'
    | 'int64'
    | 'int32'
    | 'int16'
    | 'int8'
    | 'uint8'
    | 'bool'
    | 'string';

  /** A minimal onnxruntime-web Tensor. Construct with `new Tensor(...)`. */
  export interface MlTensor {
    readonly type: MlTensorType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly data: any;
    readonly dims: readonly number[];
  }

  /** Tensor constructor (subset of onnxruntime-web's Tensor). */
  export const Tensor: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (type: MlTensorType, data: any, dims?: readonly number[]): MlTensor;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (data: any, dims?: readonly number[]): MlTensor;
  };

  /** An opaque compiled model session. Pass to `run()` / `dispose()`. */
  export interface InferenceSession {
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    run(
      feeds: Record<string, MlTensor>,
      options?: Record<string, unknown>,
    ): Promise<Record<string, MlTensor>>;
    release?(): Promise<void>;
  }

  export interface MlCapabilities {
    /** WebGPU adapter available in this tab. */
    webgpu: boolean;
    /** Adapter supports `shader-f16` (half-precision compute). */
    f16: boolean;
    /** `maxBufferSize` in bytes (0 when no WebGPU). */
    maxBufferSize: number;
    /** `maxStorageBufferBindingSize` — the practical per-tensor ceiling, in bytes. */
    maxStorageBufferBindingSize: number;
    /** Rough usable single-model GPU budget, in bytes. */
    estMemoryBudget: number;
    /** Human-readable adapter description, when available. */
    adapter?: string;
  }

  export interface DownloadProgress {
    loaded: number;
    total: number;
    /** loaded/total in [0, 1] (0 when total is unknown). */
    ratio: number;
    /** True when served from the IndexedDB cache (no network). */
    cached?: boolean;
  }

  export interface FetchWeightsOptions {
    onProgress?: (p: DownloadProgress) => void;
    force?: boolean;
    signal?: AbortSignal;
  }

  export interface SessionOptions {
    backend?: Backend;
    onProgress?: (p: DownloadProgress) => void;
    signal?: AbortSignal;
    sessionOptions?: Record<string, unknown>;
  }

  /** One remote weight file and the storage path it should land at. */
  export interface WeightFile {
    /** Remote URL to pull from (HuggingFace `resolve/…`, a CDN, …). */
    url: string;
    /** Storage-relative destination; `apps/self/` is this app's own storage. */
    dest: string;
    /** Expected size, for the progress bar before the server reports a real total. */
    bytes?: number;
  }

  export interface PrefetchProgress {
    file: WeightFile;
    /** 1-based index of the current file. */
    index: number;
    count: number;
    /** Bytes of the current file. */
    loaded: number;
    total: number;
    /** Bytes across the whole set. */
    overallLoaded: number;
    overallTotal: number;
  }

  export interface PrefetchOptions {
    onProgress?: (p: PrefetchProgress) => void;
    signal?: AbortSignal;
    /** Poll interval for download progress. Default 500 ms. */
    pollIntervalMs?: number;
  }

  /** Detect WebGPU/f16 support and GPU buffer limits. Never throws; cached. */
  export function capabilities(): Promise<MlCapabilities>;

  /** Download weights (IndexedDB-cached, streamed with progress) as an ArrayBuffer. */
  export function fetchWeights(url: string, opts?: FetchWeightsOptions): Promise<ArrayBuffer>;

  /**
   * Stream weight files to this machine's storage (server-side, resumable) and
   * return the same-origin URLs to read them back from. Files already on disk
   * complete instantly, so this is safe to call on every boot.
   */
  export function prefetchWeights(files: WeightFile[], opts?: PrefetchOptions): Promise<string[]>;

  /** The `/api/storage/…` URL a prefetched `dest` is read back from. */
  export function weightUrl(dest: string): string;

  /** Remove one cached weight file, or the whole cache when no URL is given. */
  export function clearCache(url?: string): Promise<void>;

  /** Create (or return a memoized) session from a model URL or raw bytes. */
  export function session(
    model: string | ArrayBuffer | Uint8Array,
    opts?: SessionOptions,
  ): Promise<InferenceSession>;

  /** Run inference: `feeds` maps input names to Tensors; resolves to the output map. */
  export function run(
    session: InferenceSession,
    feeds: Record<string, MlTensor>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, MlTensor>>;

  /** Release a session's native resources. */
  export function dispose(session: InferenceSession): Promise<void>;

  /**
   * Release every memoized session whose model URL matches, freeing GPU memory.
   *
   * `session()` memoizes by URL and ORT frees GPU memory only on an explicit
   * release, so a bare `dispose()` leaves a released handle in the memo. Use this
   * to swap model sizes or drop one model before loading another.
   */
  export function releaseSessions(match: (url: string) => boolean): Promise<void>;

  /** onnxruntime-web env (advanced tuning). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const env: any;
  /** The raw onnxruntime-web namespace, for APIs not surfaced above. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ort: any;
}

declare module '@bundled/yaar-web' {
  // ── Tab lifecycle ──────────────────────────────────────────────
  //
  // A `browserId` is a TAB, not an isolated browser. Every tab lives in one
  // shared Chrome profile, so cookies, localStorage, and logins are SHARED
  // across browserIds — opening a new browserId does not give you a clean
  // session. Real isolation exists only between this headless sandbox and the
  // user's own Chrome, which apps cannot reach at all.
  //
  // At most 5 tabs may be open at once; `create` fails beyond that, so close
  // tabs you are done with. `browserId` defaults to '0' everywhere.

  /**
   * Every function here resolves to this envelope, NOT to the payload directly.
   * The payload is in `content[0].text` — a plain string for text results, a
   * JSON string for structured ones (parse it). Always check `isError`.
   */
  export interface WebResult {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
      | { type: string; [key: string]: unknown }
    >;
    isError?: boolean;
  }

  /** Create a new browser tab without navigating. */
  export function create(opts?: {
    browserId?: string;
    mobile?: boolean;
    visible?: boolean;
  }): Promise<unknown>;
  /** List all open browser tabs. */
  export function listTabs(): Promise<unknown>;
  /** Close a browser tab. */
  export function closeTab(browserId?: string): Promise<unknown>;

  // ── Navigation ─────────────────────────────────────────────────
  /** Open a URL (creates tab if needed, reuses if exists). */
  export function open(
    url: string,
    opts?: {
      browserId?: string;
      mobile?: boolean;
      visible?: boolean;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    },
  ): Promise<unknown>;
  /** Navigate to a URL or go back/forward in history. */
  export function navigate(url: string, browserId?: string): Promise<unknown>;
  export function navigate(opts: {
    direction: 'back' | 'forward';
    browserId?: string;
  }): Promise<unknown>;
  /** Scroll by `amount` pixels (default 500) in one step. */
  export function scroll(opts: {
    direction: 'up' | 'down';
    amount?: number;
    browserId?: string;
  }): Promise<unknown>;
  /**
   * Scroll to the bottom one viewport at a time, dwelling after each step so
   * lazy-loaded content can extend the page. Stops when the document height
   * stops growing or `maxSteps` (default 40) is reached.
   *
   * `content[0].text` is JSON: `{ steps, finalHeight, reachedBottom }`.
   */
  export function scrollToBottom(opts?: {
    maxSteps?: number;
    /** Pause after each step, ms (default 400). Raise it for slow loaders. */
    dwellMs?: number;
    browserId?: string;
  }): Promise<WebResult>;

  // ── Interaction ────────────────────────────────────────────────
  export function click(opts: {
    selector?: string;
    text?: string;
    x?: number;
    y?: number;
    index?: number;
    browserId?: string;
  }): Promise<unknown>;
  export function type(opts: {
    selector: string;
    text: string;
    browserId?: string;
  }): Promise<unknown>;
  export function press(opts: {
    key: string;
    selector?: string;
    browserId?: string;
  }): Promise<unknown>;
  export function hover(opts: {
    selector?: string;
    text?: string;
    x?: number;
    y?: number;
    browserId?: string;
  }): Promise<unknown>;

  // ── Observation ────────────────────────────────────────────────
  export function waitFor(opts: {
    selector: string;
    timeout?: number;
    browserId?: string;
  }): Promise<unknown>;
  export function screenshot(opts?: {
    x0?: number;
    y0?: number;
    x1?: number;
    y1?: number;
    browserId?: string;
  }): Promise<unknown>;
  export function extract(opts?: {
    selector?: string;
    mainContentOnly?: boolean;
    maxTextLength?: number;
    maxLinks?: number;
    browserId?: string;
  }): Promise<unknown>;
  export function extractImages(opts?: {
    selector?: string;
    mainContentOnly?: boolean;
    minWidth?: number;
    minHeight?: number;
    extensions?: string[];
    browserId?: string;
  }): Promise<unknown>;
  /**
   * Page HTML, in `content[0].text`.
   *
   * The default is `document.body.innerHTML` — a FRAGMENT. There is no doctype,
   * no `<head>`, no `<title>`, and no page metadata of any kind. Do not feed it
   * to a parser expecting a document, and do not read a title out of it.
   *
   * - `outerHTML: true` — include the element's own tag; with no selector that
   *   is the whole `<html>` element (still no doctype).
   * - `includeMeta: true` — `content[0].text` becomes JSON
   *   `{ html, url, title, readyState }` instead of a bare string. This is the
   *   only way to learn which URL the HTML actually came from.
   */
  export function html(opts?: {
    selector?: string;
    outerHTML?: boolean;
    includeMeta?: boolean;
    browserId?: string;
  }): Promise<WebResult>;
  /**
   * Evaluate an expression in the page; the result is JSON in `content[0].text`.
   *
   * Promises are awaited, so a page-side `await sleep(...)` counts against the
   * budget. `timeoutMs` defaults to 15000 and is capped at 120000 — raise it for
   * anything that polls or waits, or the call fails with a CDP timeout that
   * looks like a page error.
   */
  export function evaluate(opts: {
    expression: string;
    timeoutMs?: number;
    browserId?: string;
  }): Promise<WebResult>;

  // ── Visual ─────────────────────────────────────────────────────
  export function annotate(browserId?: string): Promise<unknown>;
  export function removeAnnotations(browserId?: string): Promise<unknown>;

  // ── Cookies ────────────────────────────────────────────────────
  export function getCookies(opts?: { urls?: string[]; browserId?: string }): Promise<
    Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
    }>
  >;
  export function setCookie(opts: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    url?: string;
    browserId?: string;
  }): Promise<unknown>;
  export function deleteCookies(opts: {
    name: string;
    domain?: string;
    path?: string;
    url?: string;
    browserId?: string;
  }): Promise<unknown>;

  // ── Deprecated ─────────────────────────────────────────────────
  /** @deprecated Use `listTabs()` instead. */
  export function listSessions(): Promise<unknown>;
  /** @deprecated Use `closeTab()` instead. */
  export function closeSession(browserId?: string): Promise<unknown>;
}

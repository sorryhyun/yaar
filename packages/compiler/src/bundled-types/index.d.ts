/**
 * Type declarations for @bundled/* imports.
 *
 * Each @bundled/foo import is resolved at build time by the Bun plugin in
 * plugins.ts. This file provides the corresponding TypeScript type mappings
 * so apps get full type-checking against upstream package types.
 */

// ── Reactivity ───────────────────────────────────────────────────────────────

declare module '@bundled/solid-js' {
  export * from 'solid-js';
}

declare module '@bundled/solid-js/html' {
  export { default } from 'solid-js/html';
}

declare module '@bundled/solid-js/web' {
  export * from 'solid-js/web';
}

declare module '@bundled/solid-js/store' {
  export * from 'solid-js/store';
}

// CSS module imports
declare module '*.css' {}

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

declare module '@bundled/prismjs' {
  export * from 'prismjs';
}

// ── Audio ───────────────────────────────────────────────────────────────────

declare module '@bundled/tone' {
  export * from 'tone';
}

// ── YAAR SDK ────────────────────────────────────────────────────────────────

// -- App Protocol --

interface YaarAppStateDescriptor<T = unknown> {
  description: string;
  handler: () => T | Promise<T>;
  schema?: object;
}

interface YaarAppCommandDescriptor<P = unknown, R = unknown> {
  description: string;
  aliases?: string[];
  handler: (params: P) => R | Promise<R>;
  params?: object;
  returns?: object;
}

interface YaarAppEventDescriptor {
  /** Human-readable description of when this channel fires (shown to the agent). */
  description: string;
}

// -- JSON Schema → TypeScript inference (used by defineCommand) --

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

interface YaarAppRegistration {
  appId: string;
  name: string;
  state: Record<string, YaarAppStateDescriptor>;
  commands: Record<string, YaarAppCommandDescriptor>;
  /** Declared event channels this app may emit via `app.emit(channel, payload)`. */
  events?: Record<string, YaarAppEventDescriptor>;
  /** Fire-and-forget callback invoked when the app window is closed. */
  onClose?: () => void;
}

interface YaarApp {
  register(config: YaarAppRegistration): void;
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
  list(dirPath?: string): Promise<unknown[]>;
  remove(path: string): Promise<void>;
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
}

interface YaarDevDeployResult {
  success: boolean;
  appId?: string;
  name?: string;
  icon?: string;
  error?: string;
}

interface YaarDev {
  compile(path: string, opts?: { title?: string }): Promise<YaarDevCompileResult>;
  typecheck(path: string): Promise<YaarDevTypecheckResult>;
  deploy(path: string, opts: YaarDevDeployOpts): Promise<YaarDevDeployResult>;
  bundledLibraries(): Promise<string[]>;
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

  /** App-scoped storage (wraps yaar://apps/self/storage/ verbs). */
  export const appStorage: YaarAppStorage;

  /** Re-exported sub-objects from window.yaar. */
  export const storage: YaarStorage;
  export const app: YaarApp;
  export const notifications: YaarNotifications;
  export const windows: YaarWindows;

  /**
   * Declare a command for `app.register({ commands })`, deriving the handler's
   * parameter type from the `params` JSON Schema.
   *
   * The schema stays a plain literal — it is still the agent-facing contract and
   * is still extracted into `dist/protocol.json` at build time. What goes away is
   * the second, unchecked declaration of the same shape:
   *
   * ```ts
   * // before — schema and annotation drift apart silently
   * focus: {
   *   description: 'Focus a tab',
   *   params: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
   *   handler: (p: { tabId: number }) => bridge.focus(p.tabId),
   * }
   *
   * // after — `p` is inferred as `{ tabId: number }`; `p.tabld` is a compile error
   * focus: defineCommand({
   *   description: 'Focus a tab',
   *   params: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
   *   handler: (p) => bridge.focus(p.tabId),
   * })
   * ```
   */
  export function defineCommand<const S extends YaarJsonSchema, R>(descriptor: {
    description: string;
    aliases?: readonly string[];
    params: S;
    returns?: object;
    handler: (params: YaarInferSchema<S>) => R | Promise<R>;
  }): YaarAppCommandDescriptor;
  /** Parameterless variant — the handler receives nothing. */
  export function defineCommand<R>(descriptor: {
    description: string;
    aliases?: readonly string[];
    returns?: object;
    handler: () => R | Promise<R>;
  }): YaarAppCommandDescriptor;

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
   */
  export function createPersistedSignal<T>(
    key: string,
    fallback: T,
    options?: { label?: string; onError?: (message: string, error: unknown) => void },
  ): [get: () => T, set: (v: T | ((prev: T) => T)) => void];

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

  /** Detect WebGPU/f16 support and GPU buffer limits. Never throws; cached. */
  export function capabilities(): Promise<MlCapabilities>;

  /** Download weights (IndexedDB-cached, streamed with progress) as an ArrayBuffer. */
  export function fetchWeights(url: string, opts?: FetchWeightsOptions): Promise<ArrayBuffer>;

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

  /** onnxruntime-web env (advanced tuning). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const env: any;
  /** The raw onnxruntime-web namespace, for APIs not surfaced above. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ort: any;
}

declare module '@bundled/yaar-web' {
  // ── Tab lifecycle ──────────────────────────────────────────────
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
  export function scroll(opts: { direction: 'up' | 'down'; browserId?: string }): Promise<unknown>;

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
  export function html(opts?: { selector?: string; browserId?: string }): Promise<unknown>;
  export function evaluate(opts: { expression: string; browserId?: string }): Promise<unknown>;

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

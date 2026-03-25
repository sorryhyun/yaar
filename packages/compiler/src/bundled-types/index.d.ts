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

interface YaarAppRegistration {
  appId: string;
  name: string;
  state: Record<string, YaarAppStateDescriptor>;
  commands: Record<string, YaarAppCommandDescriptor>;
}

interface YaarApp {
  register(config: YaarAppRegistration): void;
  sendInteraction(
    description:
      | string
      | (Record<string, unknown> & { instructions?: string; toMonitor?: boolean }),
  ): void;
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

interface YaarAppStorage {
  save(path: string, content: string, options?: YaarAppStorageSaveOptions): Promise<void>;
  read(path: string): Promise<string>;
  readJson<T = unknown>(path: string): Promise<T>;
  /** Read JSON with a fallback value returned when the file doesn't exist or is unparseable. */
  readJsonOr<T>(path: string, fallback: T): Promise<T>;
  readBinary(path: string): Promise<{ data: string; mimeType: string }>;
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
}

interface YaarDevTypecheckResult {
  success: boolean;
  diagnostics: string[];
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

  /** Returns a promise that resolves after `ms` milliseconds. */
  export function wait(ms: number): Promise<void>;

  /** Extract a human-readable message from any thrown value. */
  export function errMsg(e: unknown): string;

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
   */
  export function createPersistedSignal<T>(
    key: string,
    fallback: T,
  ): [get: () => T, set: (v: T | ((prev: T) => T)) => void];

  /** The raw window.yaar global. */
  export const yaar: YaarGlobal;
  export default YaarGlobal;
}

// ── Gated SDKs ─────────────────────────────────────────────────────────────
// Require "bundles": ["yaar-dev"] or ["yaar-web"] in app.json to import.

declare module '@bundled/yaar-dev' {
  export function compile(path: string, opts?: { title?: string }): Promise<YaarDevCompileResult>;
  export function typecheck(path: string): Promise<YaarDevTypecheckResult>;
  export function deploy(path: string, opts: YaarDevDeployOpts): Promise<YaarDevDeployResult>;
  export function bundledLibraries(): Promise<string[]>;
}

declare module '@bundled/yaar-web' {
  export function open(
    url: string,
    opts?: {
      browserId?: string;
      mobile?: boolean;
      visible?: boolean;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    },
  ): Promise<unknown>;
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
  export function scroll(opts: { direction: 'up' | 'down'; browserId?: string }): Promise<unknown>;
  export function navigate(url: string, browserId?: string): Promise<unknown>;
  export function navigateBack(browserId?: string): Promise<unknown>;
  export function navigateForward(browserId?: string): Promise<unknown>;
  export function hover(opts: {
    selector?: string;
    text?: string;
    x?: number;
    y?: number;
    browserId?: string;
  }): Promise<unknown>;
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
    browserId?: string;
  }): Promise<unknown>;
  export function html(opts?: { selector?: string; browserId?: string }): Promise<unknown>;
  export function annotate(browserId?: string): Promise<unknown>;
  export function removeAnnotations(browserId?: string): Promise<unknown>;
  export function listSessions(): Promise<unknown[]>;
  export function closeSession(browserId?: string): Promise<unknown>;
}

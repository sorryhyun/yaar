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
    description: string | (Record<string, unknown> & { instructions?: string; toMonitor?: boolean }),
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
  readBinary(path: string): Promise<{ data: string; mimeType: string }>;
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

// -- Verb SDK --

interface YaarVerbResultContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

interface YaarVerbResult {
  content: YaarVerbResultContent[];
  isError?: boolean;
}

// -- Global --

interface YaarGlobal {
  app: YaarApp;
  storage: YaarStorage;
  notifications: YaarNotifications;
  windows: YaarWindows;

  /** Execute an action on a yaar:// resource. */
  invoke(uri: string, payload?: Record<string, unknown>): Promise<YaarVerbResult>;
  /** Read the current value/state of a yaar:// resource. */
  read(uri: string): Promise<YaarVerbResult>;
  /** List child resources under a yaar:// URI. */
  list(uri: string): Promise<YaarVerbResult>;
  /** Describe a yaar:// resource (supported verbs, schema). */
  describe(uri: string): Promise<YaarVerbResult>;
  /** Delete a yaar:// resource. */
  delete(uri: string): Promise<YaarVerbResult>;
}

interface Window {
  yaar?: YaarGlobal;
}

// -- @bundled/yaar module --

declare module '@bundled/yaar' {
  /** Read a URI and auto-parse the text response as JSON. */
  export function readJson<T = unknown>(uri: string): Promise<T>;
  /** Read a URI and return the raw text. */
  export function readText(uri: string): Promise<string>;
  /** Invoke a URI and auto-parse the response as JSON. */
  export function invokeJson<T = unknown>(
    uri: string,
    payload?: Record<string, unknown>,
  ): Promise<T>;
  /** Invoke a URI and return the raw text. */
  export function invokeText(
    uri: string,
    payload?: Record<string, unknown>,
  ): Promise<string>;
  /** List a URI and auto-parse as JSON. */
  export function listJson<T = unknown>(uri: string): Promise<T>;
  /** List a URI and return the raw text. */
  export function listText(uri: string): Promise<string>;
  /** Describe a URI and auto-parse the response as JSON. */
  export function describeJson<T = unknown>(uri: string): Promise<T>;
  /** Delete a URI and return the raw text response. */
  export function deleteText(uri: string): Promise<string>;

  /** Raw verb passthrough — returns YaarVerbResult. */
  export function invoke(uri: string, payload?: Record<string, unknown>): Promise<YaarVerbResult>;
  export function read(uri: string): Promise<YaarVerbResult>;
  export function list(uri: string): Promise<YaarVerbResult>;
  export function describe(uri: string): Promise<YaarVerbResult>;
  export function del(uri: string): Promise<YaarVerbResult>;
  export function subscribe(uri: string, callback: (uri: string) => void): Promise<() => void>;

  /** App-scoped storage (wraps yaar://apps/self/storage/ verbs). */
  export const appStorage: YaarAppStorage;

  /** Re-exported sub-objects from window.yaar. */
  export const storage: YaarStorage;
  export const app: YaarApp;
  export const notifications: YaarNotifications;
  export const windows: YaarWindows;

  /** Dev tools — compile, typecheck, deploy from iframe apps. */
  export const dev: YaarDev;

  /** Returns a promise that resolves after `ms` milliseconds. */
  export function wait(ms: number): Promise<void>;

  /** The raw window.yaar global. */
  export const yaar: YaarGlobal;
  export default YaarGlobal;
}

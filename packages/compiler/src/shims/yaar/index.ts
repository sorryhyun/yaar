// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Importable SDK for @bundled/yaar.
 *
 * Thin wrapper around the `window.yaar` global (injected by the verb SDK script).
 * The verb proxy returns a JSON envelope; callVerb() unwraps it, so verb
 * functions already return parsed data. The typed helpers just pass through.
 *
 * Usage:
 *   import { read, invoke, list, storage } from '@bundled/yaar';
 *   const settings = await read<Settings>('yaar://config/settings');
 *
 * This file is the single public entry point. The sibling modules are internal
 * ownership boundaries — `@bundled/yaar/verbs` is deliberately not a thing, and
 * the declared type surface lives in `bundled-types/index.d.ts`.
 */

import { y } from './verbs.js';

// ── Verb functions + sub-object re-exports ───────────────────────
export {
  read,
  invoke,
  list,
  describe,
  del,
  subscribe,
  httpFetch,
  stream,
  storage,
  app,
  notifications,
  windows,
} from './verbs.js';
export type { StreamFrame } from './verbs.js';

// ── App-scoped storage ──────────────────────────────────────────
export { appStorage } from './app-storage.js';
export type { YaarAppStorageEntry } from './app-storage.js';

// ── App-scoped database ─────────────────────────────────────────
export { appDb } from './app-db.js';

// ── Descriptor builders, utilities, toasts, shortcuts ───────────
export {
  defineCommand,
  defineAppCommand,
  wait,
  errMsg,
  AppCommandError,
  showToast,
  withLoading,
  createStaleGuard,
  onShortcut,
} from './ui.js';

// ── HTML sanitization ───────────────────────────────────────────
export { sanitizeHtml } from './sanitize.js';
export type { SanitizeHtmlOptions } from './sanitize.js';

// ── Protocol handler context ────────────────────────────────────
export { createProtocolContext } from './protocol-context.js';

// ── The app entrypoint ──────────────────────────────────────────
export { defineApp } from './define-app.js';

// ── Dialogs ─────────────────────────────────────────────────────
export { showAlert, showConfirm, showPrompt } from './dialogs.js';
export type { DialogOptions } from './dialogs.js';

// ── Reactive primitives ─────────────────────────────────────────
export { createPersistedSignal, createCollapsiblePanel, createAutosave } from './reactive.js';

// ── Default export: the raw global ───────────────────────────────

export const yaar = y;
export default y;

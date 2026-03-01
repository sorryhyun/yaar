/// <reference lib="dom" />
/**
 * @bundled/yaar — Tiny reactive DOM library for YAAR apps.
 *
 * Pure browser ES module. No Node.js APIs.
 * Provides: signals, computed, effects, hyperscript DOM, list rendering, toast.
 *
 * This file is excluded from server tsc (it's a browser library).
 * Compiled at runtime by the Bun plugin for @bundled/yaar imports.
 */

export { signal, computed, effect, batch, onCleanup, onMount, untrack } from './reactivity.ts';
export type { Signal } from './reactivity.ts';
export { h, mount } from './dom.ts';
export type { Child, Props } from './dom.ts';
export { html } from './html.ts';
export { css } from './css.ts';
export { list } from './list.ts';
export { show, createResource } from './helpers.ts';
export type { Resource } from './helpers.ts';
export { Toast } from './toast.ts';

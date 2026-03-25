/**
 * Bun test setup file.
 * Runs before each test file.
 */

import { GlobalWindow } from 'happy-dom';

// Set up happy-dom globals for DOM testing
const window = new GlobalWindow();
const domGlobals = [
  'document',
  'window',
  'navigator',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLIFrameElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'HTMLAnchorElement',
  'HTMLImageElement',
  'HTMLSpanElement',
  'Node',
  'Element',
  'DocumentFragment',
  'Event',
  'CustomEvent',
  'MessageEvent',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'InputEvent',
  'MutationObserver',
  'IntersectionObserver',
  'ResizeObserver',
  'DOMParser',
  'XMLSerializer',
  'URL',
  'URLSearchParams',
  'Headers',
  'Request',
  'Response',
  'AbortController',
  'AbortSignal',
  'Blob',
  'File',
  'FileList',
  'FileReader',
  'FormData',
  'Range',
  'Selection',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
] as const;

for (const key of domGlobals) {
  if (!(key in globalThis) && key in window) {
    // @ts-expect-error - assigning DOM globals
    globalThis[key] = window[key];
  }
}

// Ensure window === globalThis for compatibility
if (!('window' in globalThis)) {
  // @ts-expect-error - setting window global
  globalThis.window = window;
}

import '@testing-library/jest-dom';
import '@/i18n'; // Initialize i18next with English locale for tests

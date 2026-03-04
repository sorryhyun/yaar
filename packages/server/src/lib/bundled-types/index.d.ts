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

// ── Documents & Code ────────────────────────────────────────────────────────

declare module '@bundled/xlsx' {
  export * from 'xlsx';
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

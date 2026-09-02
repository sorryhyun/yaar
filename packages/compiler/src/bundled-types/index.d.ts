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
  // Nested reactive state. Every app here imports `createStore` and stops there,
  // which is why nested updates get written as hand-rolled spread pyramids:
  //   setState('a', { ...state.a, b: { ...state.a.b, c: 1 } })
  // The four helpers below exist to delete that code.
  //
  //   createStore(initial) -> [state, setState]
  //     setState takes a PATH before the value, and the path may contain an
  //     array of keys, an index range, or a filter function:
  //       setState('items', (i) => i.id === id, 'done', true)
  //     A function value receives the previous one: setState('count', (c) => c + 1)
  //
  //   produce(fn)      Immer-style mutable draft for one update — the readable
  //                    way to write a deep change:
  //                      setState(produce((s) => { s.a.b.c = 1; s.list.push(x) }))
  //                    Solid does NOT diff: it applies your mutations straight to
  //                    the store proxy, so only the properties you touched
  //                    invalidate. Reach for this, not an immutable-copy library
  //                    (immer, mutative) — replacing a subtree with a fresh object
  //                    invalidates the whole subtree, so an external copy library
  //                    makes reactivity strictly coarser here, not faster.
  //
  //   reconcile(next)  Merge a whole new value in while KEEPING identity for the
  //                    parts that did not change — the one to use after a fetch or
  //                    a storage read, so a re-fetch of 200 rows re-renders only
  //                    the rows whose fields differ:
  //                      setState('rows', reconcile(fresh, { key: 'id' }))
  //                    Assigning `setState('rows', fresh)` instead re-renders all
  //                    200 and loses per-row state (scroll, focus, open/closed).
  //
  //   unwrap(state)    The raw underlying object, no proxy. Use it when handing
  //                    state to something outside Solid — JSON.stringify, an
  //                    appStorage write, a worker postMessage, a canvas library.
  //
  //   createMutable(o) A store you assign to directly (`obj.a.b = 1`), no setter.
  //                    Convenient, but the mutation site is invisible at a glance;
  //                    prefer createStore + produce for anything shared.
  export * from 'solid-js/store';
}

// CSS module imports
declare module '*.css' {}

// Static-asset imports — inlined as base64 `data:` URIs by `assetDataUrlPlugin`
// (bundled/plugins.ts). Each default export is the data-URI string, usable
// directly in `<img src>`, CSS `url()`, `fetch()`, `new Audio()`, a loader's
// `.load(url)`, etc.
//
// This list is the type-side half of `ASSET_MIME_TYPES`; the two are asserted
// equal by `asset-imports.test.ts`, because a declaration without a MIME entry
// typechecks and then fails the build, and a MIME entry without a declaration
// builds and then fails the typecheck.
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
declare module '*.glb' {
  const src: string;
  export default src;
}
declare module '*.gltf' {
  const src: string;
  export default src;
}
declare module '*.bin' {
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

declare module '@bundled/three/addons' {
  // A curated slice of three's `examples/jsm`. Reach for `GLTFLoader` rather than
  // parsing glTF/GLB yourself — two apps each hand-rolled a reader (accessors, PBR
  // materials, embedded textures) before this module existed.
  //
  // `GLTFLoader.parse(arrayBuffer, '', onLoad)` is the entry point for bytes you
  // already hold — an imported `.glb` (inlined as a `data:` URI), or a file read out
  // of storage. `.load(url, …)` fetches instead.
  //
  // Not here on purpose: `DRACOLoader`, `KTX2Loader` and `MeshoptDecoder`. They fetch
  // a decoder (`.wasm` + a worker) from a path set at runtime, and a YAAR app is a
  // single HTML file with no siblings to serve, so they would compile and then fail on
  // first use. Uncompressed glTF/GLB needs none of them.
  export { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
  export { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
  export { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
  export { STLLoader } from 'three/addons/loaders/STLLoader.js';
  export { FontLoader, Font } from 'three/addons/loaders/FontLoader.js';
  export { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
  export { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
  export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  export { MapControls } from 'three/addons/controls/MapControls.js';
  export { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
  export { TransformControls } from 'three/addons/controls/TransformControls.js';
  export { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
  export * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
  export * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
}

declare module '@bundled/cannon-es' {
  export * from 'cannon-es';
}

// ── 2D Graphics ─────────────────────────────────────────────────────────────

declare module '@bundled/pixi.js' {
  export * from 'pixi.js';
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

declare module '@bundled/mermaid' {
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

declare module '@bundled/zod' {
  // Zod MINI — the tree-shakeable functional API, not standard Zod's chained one:
  // `z.optional(z.string())` not `z.string().optional()`, and `z.safeParse(Schema, data)`
  // not `Schema.safeParse(data)`. (Standard Zod's `z` namespace defeats tree-shaking and
  // pulls ~260KB into every consuming app; Mini bundles to ~10KB.) The same `z` that
  // `defineApp` accepts for command `params`. See https://zod.dev/packages/mini
  //
  // Validate at trust boundaries — external HTTP responses, persisted JSON whose shape
  // may predate the current app version, command params — not ordinary internal state,
  // and only the fields you read. Reach for `z.looseObject` when the item is spread
  // downstream: it keeps unknown keys, so additive upstream fields survive. The shape:
  //
  //   const Item = z.looseObject({ id: z.optional(z.string()), title: z.optional(z.string()) });
  //   const parsed = z.safeParse(z.array(Item), await resp.json());
  //   if (!parsed.success) {
  //     console.error('feed validation failed', parsed.error.issues); // full issues to console
  //     throw new Error('The service returned an unsupported response.'); // concise user error
  //   }
  //   return parsed.data; // typed, no cast
  export * from 'zod/mini';
}

// ── Audio ───────────────────────────────────────────────────────────────────

declare module '@bundled/tone' {
  export * from 'tone';
}

// ── Media Files ─────────────────────────────────────────────────────────────

declare module '@bundled/mediabunny' {
  // Reading, writing, and converting media containers — mp4, webm/mkv, mp3, wav,
  // ogg — which the browser otherwise offers no API for. The alternative an app
  // reaches for on its own is `MediaRecorder` over `canvas.captureStream()`, and it
  // is worse in three ways that matter: it records in REAL TIME (a slow frame is a
  // dropped or duplicated frame), it only writes what the browser felt like
  // supporting, and it cannot read an existing file at all. mediabunny encodes
  // frame by frame with explicit timestamps, decoupled from wall-clock.
  //
  // Encoding and decoding need WebCodecs; muxing and demuxing alone do not.
  // Support is per codec AND per platform, so branch on the capability check
  // instead of assuming — `getFirstEncodableVideoCodec(['avc', 'vp9'], { width,
  // height })` returns null when nothing on this machine can do it, which is the
  // answer you want BEFORE rendering 900 frames.
  //
  // Two exported names shadow DOM globals: `BufferSource` (mediabunny's is an
  // input Source; the DOM's is the ArrayBuffer/-View type alias) and `MediaSource`
  // (the abstract base class here, MSE there). Alias on import if an app needs both.
  // READ — an `Input` over a `Source`, with sinks pulling decoded media out.
  //   const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  //   sources: BlobSource, BufferSource, UrlSource, StreamSource
  //   formats: ALL_FORMATS, or narrow to MP4 / WEBM / MATROSKA / MP3 / WAVE /
  //            OGG / QTFF / ADTS / FLAC to shrink the bundle
  //   input.getPrimaryVideoTrack() / .getPrimaryAudioTrack() / .computeDuration()
  //   sinks:  VideoSampleSink, CanvasSink, AudioBufferSink, EncodedPacketSink
  //           .getSample(t) / .getCanvas(t) for one seek;
  //           .samples(start?, end?) / .canvases(start?, end?) async-iterate a range
  //
  // WRITE — an `Output` (format + target) fed by sources, one `add` per frame.
  //   const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  //   const src = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
  //   output.addVideoTrack(src, { frameRate: 30 });
  //   await output.start();
  //   for each frame: draw, then `await src.add(timeInSeconds, durationInSeconds)`
  //   await output.finalize();  // then `output.target.buffer` is the ArrayBuffer
  //   formats: Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat,
  //            Mp3OutputFormat, WavOutputFormat, OggOutputFormat
  //   targets: BufferTarget (buffer is null until finalize), StreamTarget
  //   sources: CanvasSource, VideoSampleSource, AudioBufferSource, AudioSampleSource,
  //            MediaStreamVideoTrackSource / MediaStreamAudioTrackSource (live capture)
  //
  // CONVERT — transcode, resize, trim, or drop tracks without wiring sinks to
  // sources by hand. This is the right tool for "make this file smaller/shorter".
  //   const c = await Conversion.init({ input, output, trim: { start: 2, end: 8 } });
  //   c.onProgress = (p) => setProgress(p);
  //   await c.execute();
  //
  // CAPABILITY — ask before you encode:
  //   canEncode / canEncodeVideo / canEncodeAudio, and the canDecode* mirrors
  //   getEncodableVideoCodecs(), getFirstEncodableVideoCodec([...], { width, height })
  //   QUALITY_VERY_LOW | QUALITY_LOW | QUALITY_MEDIUM | QUALITY_HIGH | QUALITY_VERY_HIGH
  //     — bitrate presets; pass one as `bitrate` rather than guessing a number.
  export * from 'mediabunny';
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
  /**
   * Optional computed doc, answered only when someone asks — `describe` on
   * `yaar://windows/{windowId}/state/{key}`.
   *
   * Never folded into the manifest: a doc computed from live data on every manifest
   * read would make the cheapest call the most expensive. Use it for what
   * `description` cannot say because it changes — "412 rows; a row is
   * `{ id, title, done }`". Omit it and `describe` answers with `description`.
   */
  describe?: () => string | Promise<string>;
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
  /** See `YaarAppStateDefinition.describe` — on-demand doc, never in the manifest. */
  describe?: () => string | Promise<string>;
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
  /** See `YaarAppStateDefinition.describe` — on-demand doc, never in the manifest. */
  describe?: () => string | Promise<string>;
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
    /** See `YaarAppStateDefinition.describe` — on-demand doc, never in the manifest. */
    describe?: () => string | Promise<string>;
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
  /** Must equal `appId` in this app's `app.json` (not `id`, which nothing reads); the build enforces it. */
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
   *
   * `wakeAgent: true` additionally wakes **this app's own agent** with the
   * event — the way to hand back the result of work it started and stopped
   * waiting for. It never *creates* an agent: with none running, the emit is
   * an ordinary one. Only the iframe knows whether its agent is waiting on
   * this event, which is why the flag is per emit and not a subscription.
   */
  emit(channel: string, payload?: unknown, opts?: { wakeAgent?: boolean }): void;
}

// -- Storage SDK --

interface YaarStorageReadOptions {
  as?: 'text' | 'json' | 'blob' | 'arraybuffer' | 'auto';
}

/**
 * Storage, addressed by a storage-root-relative path: `shared/x.png` for the commons,
 * `apps/self/x.png` for this app's own tree.
 *
 * Every method accepts **any** spelling of a stored file — a bare path, a
 * `yaar://storage/…` URI, a `yaar://apps/{id|self}/storage/…` URI, or an
 * `/api/storage/…` URL — because one file has all four names and which one you hold
 * depends on the layer that handed it over. A reference that is not storage at all
 * (an `https://` URL, a `data:` URL, a path containing `..`) is refused by name.
 * Use `storagePath()` to test a reference instead of catching.
 */
/** One entry from a storage listing. Paths are storage-root-relative. */
interface YaarStorageEntry {
  path: string;
  isDirectory: boolean;
  /** Bytes. `0` for directories. */
  size?: number;
  /** ISO timestamp of the last write. */
  modifiedAt?: string;
}

interface YaarStorage {
  save(path: string, data: string | Blob | ArrayBuffer | Uint8Array): Promise<{ ok: boolean }>;
  read(path: string, options?: YaarStorageReadOptions): Promise<unknown>;
  /** Omit (or pass an empty string) for the storage root. */
  list(dirPath?: string): Promise<YaarStorageEntry[]>;
  remove(path: string): Promise<{ ok: boolean }>;
  /** A URL an `<img src>`/`<video>`/CSS `url()` can load — carries the iframe token. */
  url(path: string): string;
  /** See the exported `storagePath`. */
  path(ref: string | undefined | null): string | null;
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
  /** Bytes. Absent for directories. */
  size?: number;
  /** ISO timestamp of the last write. */
  modifiedAt?: string;
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
  /**
   * Read JSON with a fallback value returned when the file doesn't exist or is unparseable.
   *
   * Sends `missingOk`, so an absent file is answered with `null` rather than a failure
   * the session counts. This is the method to reach for on any optional config file —
   * a bare `readJson` in a `try/catch` handles absence for your app and records it
   * against the session anyway.
   */
  readJsonOr<T>(path: string, fallback: T): Promise<T>;
  /**
   * A file's bytes as base64, with the MIME type the server served them under.
   *
   * The stored bytes, whatever the type: not the "Binary file (…) — cannot be read as
   * text" notice the verb layer answers a `.glb` with, and not the WebP re-encode it
   * applies to an image on the way into a model's context.
   *
   * `encoding` is always `'base64'`; the union is kept so existing callers that narrow
   * on it still compile. Prefer `readBlob` unless you need base64 (a data URL, or a
   * `save(..., { encoding: 'base64' })` round trip).
   */
  readBinary(
    path: string,
  ): Promise<{ data: string; mimeType: string; encoding: 'base64' | 'text' }>;
  /** A file's bytes as a Blob — the form an `<img>`, a canvas or a parser wants. */
  readBlob(path: string): Promise<Blob>;
  list(dirPath?: string): Promise<YaarAppStorageEntry[]>;
  remove(path: string): Promise<void>;
}

// -- The commons, scoped to this app's directory in it --

interface YaarPublishOptions {
  /** Name for the file in the commons. Defaults to `from`'s own basename. */
  as?: string;
}

interface YaarPublishResult {
  /** Root-relative path: `shared/{appId}/{name}`, with the real id — safe to hand outward. */
  path: string;
  /** The same file as a `yaar://storage/…` URI. */
  uri: string;
  /** The name inside this app's commons directory. */
  name: string;
}

/**
 * `yaar://storage/shared/{appId}/…` — the tree apps publish artifacts to for each other,
 * granted to every app for being an app, and scoped here to the directory this app owns.
 *
 * Use it when the app is producing something for others to find; use `appStorage` for
 * files no other app should see, and the flat `storage` API when you hold a path someone
 * else produced. Names are subpaths (`'renders/final.png'`), a leading slash is ignored
 * and `..` is refused; a name that already spells out this app's own commons directory is
 * taken as-is rather than nested twice, so a path from `list()` round-trips.
 *
 * Which directory is yours is decided by the **server**, from the iframe token: paths go
 * out spelled `shared/self/…` and are expanded against the calling principal, exactly like
 * `apps/self`. So a devtools preview writes to its own directory instead of the shipped
 * app's, and these methods work at module scope — they no longer need `defineApp` first.
 */
interface YaarSharedStorage {
  /**
   * This app's directory in the commons, as a root-relative path — `shared/{appId}` once
   * a call has reported the resolved path back (any `save`, `list` or `publish` does),
   * `shared/self` until then. Both name the same directory to every YAAR door; only a
   * *monitor* agent, which has no app identity, cannot resolve the pronoun.
   */
  readonly dir: string;
  /** A name inside this app's commons directory, as a root-relative path. */
  path(name?: string): string;
  /** A name inside this app's commons directory, as a `yaar://storage/…` URI. */
  uri(name?: string): string;
  /** A URL an `<img src>`/`<video>`/CSS `url()` can load — carries the iframe token. */
  url(name: string): string;
  save(name: string, data: string | Blob | ArrayBuffer | Uint8Array): Promise<void>;
  read(name: string, options?: YaarStorageReadOptions): Promise<unknown>;
  /** Read as a Blob — the form an `<img>`, a canvas or `mediabunny` wants. */
  readBlob(name: string): Promise<Blob>;
  /** List this app's commons directory, or a subdirectory of it. */
  list(subdir?: string): Promise<YaarStorageEntry[]>;
  remove(name: string): Promise<void>;
  /**
   * Copy a file already in storage into this app's commons directory.
   *
   * The copy happens **server-side** — `from` is a reference, not bytes, so publishing a
   * 500KB image does not route it through the iframe (or, once an agent asks about it,
   * through a model context). `from` accepts any spelling of a stored file.
   */
  publish(from: string, options?: YaarPublishOptions): Promise<YaarPublishResult>;
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
  /**
   * Open an http(s) URL in a window of its own, without leaving YAAR.
   *
   * This is where an external link inside an app should go. A plain `<a href>`
   * navigates the app's *own* frame — replacing the app document and every script
   * in it, the app protocol included. Fire-and-forget: the desktop owns window
   * creation.
   *
   * `window.open(url)` is shimmed onto this same path, so there is no need to
   * hand-roll a popup with a clipboard fallback — an app frame cannot open a
   * browser tab, and a "popup blocked" branch will never be the reason a link
   * fails to open.
   */
  openUrl(url: string, opts?: { title?: string }): void;
}

/**
 * What a link in this app's content should do, when the default is not right.
 *
 * The default already is right for most apps: every anchor click is intercepted
 * before it can navigate the app's own frame, and the destination opens as a YAAR
 * window — `target="_blank"`, a middle click and a ctrl/cmd-click included. You do
 * not need to write a click handler, and you must not write one around
 * `window.open` with a clipboard fallback; that was the pre-`openUrl` workaround.
 *
 * Two things the default cannot know, one declarative and one not:
 *   - which site a RELATIVE href in your content belongs to -> `"links": { "base" }`
 *     in app.json, since that is a fact about the app, not a decision;
 *   - whether a particular URL is really *yours* -> `onOpen`, below.
 */
interface YaarLinks {
  /** Open an http(s) URL in a window of its own. Same door as `windows.openUrl`. */
  open(url: string, opts?: { title?: string }): void;
  /**
   * Decide what a link in this app's content means. Call once, at module scope.
   *
   * Runs for every link activation the guard intercepts and for `window.open`,
   * with the resolved absolute URL and the anchor it came from (`null` when there
   * isn't one). It does NOT run for your own `links.open` calls — those already
   * name their destination.
   *
   * Return a **string** to open that instead (unwrap a redirect interstitial,
   * canonicalize a mirror), **false** to claim the link yourself (in-app routing;
   * no window opens), or nothing to open the URL as given. A handler that throws
   * opens the URL unchanged rather than swallowing the click.
   *
   *   links.onOpen((url) => {
   *     const id = postIdInThisGallery(url);
   *     if (id) { selectPost(id); return false; }
   *     return unwrapRedirect(url);
   *   });
   */
  onOpen(handler: (url: string, anchor: HTMLAnchorElement | null) => string | false | void): void;
  /**
   * The absolute, openable URL for an href — resolved against this app's declared
   * `links.base` — or null when there is nothing to open (empty, a bare `#fragment`,
   * `mailto:`, an unparseable value). The same answer the guard uses, for a control
   * that opens a URL without being an anchor.
   */
  resolve(href: string | null | undefined): string | null;
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

interface YaarDevFormatResult {
  success: boolean;
  /** The formatted text. Present only on success. */
  formatted?: string;
  /** False when the file was already formatted — nothing to write. */
  changed?: boolean;
  /**
   * Which refusal this is: `unsupported` (nothing formats that extension),
   * `unavailable` (this build ships no prettier), `parse` (prettier could not read
   * the code — `error` carries the line).
   */
  kind?: 'unsupported' | 'unavailable' | 'parse';
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
  /**
   * Set when you deployed the app you are running inside — a self-deploy. Your window is
   * spared (closing it would kill this very request) and is therefore still executing the
   * bundle the deploy replaced. Anything checked in it from here on is a false result.
   * Reload it once this call has returned:
   * `invoke('yaar://windows/{id}', { action: 'reload' })`, which re-mounts the iframe
   * without discarding the window's app agent.
   */
  staleWindow?: string;
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
  /**
   * Return per-file line counts (`stat`) instead of the diff text. A whole-app diff
   * is tens of kilobytes; this answers "how much changed" in a few hundred bytes.
   */
  statOnly?: boolean;
  /** Limit the diff to these app-relative paths. Feed `files` or `stat[].file` back in. */
  paths?: string[];
}

interface YaarDevDiffResult {
  success: boolean;
  /** Unified diff. Empty when there are no changes, and always empty under `statOnly`. */
  diff?: string;
  /** Paths touched, relative to the app directory. */
  files?: string[];
  /** Per-file line counts. Returned in place of `diff` under `statOnly`. */
  stat?: { file: string; added: number; removed: number }[];
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
  format(path: string, source: string): Promise<YaarDevFormatResult>;
  deploy(path: string, opts: YaarDevDeployOpts): Promise<YaarDevDeployResult>;
  bundledLibraries(): Promise<string[]>;
  gitHistory(appId?: string, opts?: { limit?: number }): Promise<YaarDevHistoryResult>;
  gitDiff(appId?: string, opts?: YaarDevDiffOpts): Promise<YaarDevDiffResult>;
  gitRestore(appId: string, ref: string): Promise<YaarDevRestoreResult>;
  gitCheckpoint(appId?: string, opts?: { message?: string }): Promise<YaarDevHistoryResult>;
}

// -- Global --

/** Options for a `read` — the verb layer's read options, as an app sees them. */
interface YaarReadOptions {
  /** Line range to read, e.g. "10-20", "50", "100-" (1-based, inclusive). */
  lines?: string;
  /** Regex — return only matching lines, with line numbers. */
  pattern?: string;
  /** Context lines around each `pattern` match (default 0). */
  context?: number;
  /** PDF only: extract the text layer. `true` (or "all") for the whole document, or a range. */
  pdfText?: boolean | string;
  /** PDF only: page range to rasterize to images, e.g. "1-3". */
  pdfPages?: string;
  /** Images only: the stored bytes instead of the WebP re-encode a read normally applies. */
  rawImage?: boolean;
  /**
   * Answer an absent resource with `null` instead of throwing.
   *
   * For the case where "it isn't there yet" is a normal answer — an optional config
   * file on a first run. Without it, a caller that handles absence perfectly still
   * leaves one recorded failure per read behind it. A resource holding a literal
   * `null` is indistinguishable from an absent one; `list` the parent if you must
   * tell them apart.
   */
  missingOk?: boolean;
}

interface YaarGlobal {
  app: YaarApp;
  storage: YaarStorage;
  notifications: YaarNotifications;
  windows: YaarWindows;
  links: YaarLinks;

  /** Execute an action on a yaar:// resource. Returns parsed data from the JSON envelope. */
  invoke<T = unknown>(uri: string, payload?: Record<string, unknown>): Promise<T>;
  /**
   * Read the current value/state of a yaar:// resource. Returns parsed data.
   *
   * Pass `{ missingOk: true }` when absence is an expected answer — you get `null`
   * instead of a rejection the session records as a failure.
   */
  read<T = unknown>(uri: string, options?: YaarReadOptions): Promise<T>;
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
  /**
   * Read the current value/state of a yaar:// resource.
   *
   * `options` are the same read options an agent has: `lines` / `pattern` / `context`
   * to filter a text file, `pdfText` / `pdfPages` for PDFs, and `missingOk` to get
   * `null` for an absent resource instead of a thrown error. Prefer `missingOk` over a
   * bare `catch` whenever absence is a state you expect — a caught failure is still a
   * failure the session recorded.
   */
  export function read<T = unknown>(uri: string, options?: YaarReadOptions): Promise<T>;
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

  /**
   * App-scoped storage (wraps yaar://apps/self/storage/ verbs). Scoped to this app: no other
   * installed app can reach it. It is still a plain subtree of YAAR storage
   * (`yaar://storage/apps/{appId}/`), visible to the user, the Storage app and agents.
   */
  export const appStorage: YaarAppStorage;

  /**
   * The commons — `yaar://storage/shared/{appId}/…` — scoped to this app's directory.
   *
   * The tree apps publish artifacts to for each other, so that a render from one app is
   * a build-time asset in another. `publish()` copies server-side, without routing the
   * bytes through the iframe. Which directory is this app's is resolved by the server
   * from the iframe token, so it works at module scope and is preview-safe.
   */
  export const sharedStorage: YaarSharedStorage;

  /**
   * App-scoped SQLite database (wraps yaar://apps/self/db/ verbs).
   * Structured collections with Mongo-style filters and full-text search.
   * Granted to every app automatically — no app.json permission entry needed.
   */
  export const appDb: YaarAppDb;

  /** Re-exported sub-objects from window.yaar. */
  export const storage: YaarStorage;

  /**
   * Any spelling of a stored file, reduced to a storage-root-relative path — or `null`
   * when the reference names something that is not storage.
   *
   * One file has four names: `shared/anima/dragon.png` from a listing,
   * `yaar://storage/…` from a verb, `yaar://apps/self/storage/…` from an app.json
   * permission or an agent, `/api/storage/…` from an HTTP route. Every `storage.*`
   * method already accepts all four, so reach for this only when you need the path
   * *itself* — to store in a document, to take a dirname, or to ask "is this a stored
   * file or a remote URL?".
   *
   * ```ts
   * const path = storagePath(slide.image);
   * img.src = path ? storage.url(path) : slide.image; // storage, or a plain URL
   * ```
   *
   * `null` means not-storage (an `https://` URL, a `data:` URL, a non-storage
   * `yaar://` resource) or a path containing `..`. It does **not** mean forbidden —
   * the iframe cannot see what a caller delegated to this window, so a path outside
   * the app's own trees still resolves and the server answers. `self` is left
   * unexpanded; `/api/storage` resolves it against the calling app.
   */
  export function storagePath(ref: string | undefined | null): string | null;

  export const app: YaarApp;
  export const notifications: YaarNotifications;
  export const windows: YaarWindows;
  export const links: YaarLinks;

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
   *   id: 'memo',                    // must equal app.json's "appId"
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

  /** Options for the modal dialog helpers (showConfirm / showPrompt). */
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
   * Run an async action; on failure log it and toast `errMsg(e)`. The
   * do-the-thing-and-say-why-it-failed try/catch, written once.
   *
   * ```ts
   * await tryToast(() => deleteRepo(name), { success: 'Deleted' });
   * ```
   *
   * Resolves the action's value, or `undefined` if it threw — check the result
   * rather than re-catching. Orthogonal to `withLoading` (which owns a loading
   * flag and knows nothing about toasts); nest them when you want both:
   * `withLoading(setBusy, () => tryToast(...))`.
   */
  export function tryToast<T>(
    fn: () => Promise<T>,
    opts?: { success?: string },
  ): Promise<T | undefined>;

  /**
   * Validate untrusted data against a schema; on mismatch log it and return
   * `fallback`. The boundary for persisted JSON and HTTP responses.
   *
   * ```ts
   * const layout = safeParseOr(LayoutSchema, await appStorage.readJsonOr('layout.json', undefined), DEFAULT_LAYOUT, {
   *   label: 'storage:layout',
   * });
   * ```
   *
   * `readJsonOr` answers "the file is missing" and "the file is garbage" with the
   * same value, so a broken app renders identically to a fresh one. This keeps
   * those apart: `undefined` (nothing stored) takes the fallback silently, while
   * a value that is present and wrong is logged with the schema's own issues.
   *
   * Takes any Standard Schema — a `@bundled/zod` schema, typically. Throws rather
   * than falling back on the caller's own bugs: a non-schema, or a schema that
   * validates asynchronously (await `schema['~standard'].validate(raw)` yourself
   * for those — this returns a value, not a promise).
   *
   * `onInvalid` replaces the default `console.error` when logging is not the
   * right answer at that boundary — it runs instead of the line, not before it:
   *
   * ```ts
   * // the call must fail rather than degrade
   * safeParseOr(S, raw, undefined, { onInvalid: () => { throw new Error('...') } });
   * // the fallback would mislead, so say so
   * safeParseOr(S, raw, EMPTY, { onInvalid: (i) => { console.error(i); showToast('...') } });
   * // a poll — log the transition into failure, not every tick
   * safeParseOr(S, raw, last, { onInvalid: () => noteSyncFailure() });
   * ```
   */
  export function safeParseOr<S, F = YaarStandardOutput<S>>(
    schema: S,
    raw: unknown,
    fallback: F,
    /**
     * `label` tags the console line, e.g. `'storage:layout'`. `onInvalid`
     * replaces that line; it never runs for an absent (`undefined`) value.
     */
    opts?: { label?: string; onInvalid?: (issues: unknown) => void },
  ): YaarStandardOutput<S> | F;

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
   * Escape text for interpolation into HTML — always covers `& < > " '`.
   *
   * The other half of the untrusted-content story: `sanitizeHtml` cleans markup
   * you mean to render, this neutralizes text you mean to show (a commit message
   * in a template literal, a filename in a `title="..."`). Escaping only
   * `& < >` is safe in a text node and not in an attribute, where a lone `"`
   * ends it and everything after is markup — so this covers both, since which
   * context a call site sits in changes when someone edits the template.
   *
   * Emits `&#39;` for the apostrophe. Escaping for an XML *document* is a
   * different grammar (`&apos;`); a DOCX or SVG serializer keeps its own.
   */
  export function escapeHtml(s: string): string;

  /**
   * Trigger a browser download of `blob`, named `filename` — the objectURL /
   * `<a download>` / click / revoke dance, with the revoke deferred a tick so it
   * cannot race the download it just scheduled.
   */
  export function downloadBlob(blob: Blob, filename: string): void;

  /**
   * Read a Blob or File into a `data:` URL (base64, with the MIME prefix).
   *
   * For an image about to be stored or shown, prefer `toWebP` — it re-encodes
   * and returns both the data URL and the raw base64 `appStorage.save(...,
   * 'base64')` wants. This is the general case: any blob, no re-encode.
   */
  export function blobToDataUrl(blob: Blob): Promise<string>;

  /**
   * The return trip: a `data:` URL back into a Blob with its declared MIME
   * type — for bytes the app already holds as one (a canvas `toDataURL`, a
   * stored image read back). Handles `;base64,` and percent-encoded bodies.
   * Throws on a string that is not a data URL; wrap it if you want `null`.
   */
  export function dataUrlToBlob(dataUrl: string): Blob;

  /**
   * Base64 → bytes, whitespace stripped first (APIs that wrap base64 at a
   * column, like GitHub's contents endpoint, hand back newlines `atob`
   * rejects). Text arrives via `new TextDecoder().decode(base64ToBytes(b64))`.
   * Throws on malformed input.
   */
  export function base64ToBytes(b64: string): Uint8Array;

  /**
   * Bytes → base64, chunked so a multi-megabyte buffer does not overflow the
   * call stack. The raw form `appStorage.save(path, data, { encoding: 'base64' })`
   * takes, for bytes that are not an image you are re-encoding — for those,
   * `toWebP` already returns it.
   */
  export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string;

  /**
   * Bytes as a human-readable size: `'0 B'`, `'834 B'`, `'1.5 KB'`, `'2.0 MB'`.
   * Binary steps (1024), one decimal above bytes. Use it rather than a local
   * ladder, so two windows never label the same file differently.
   */
  export function formatBytes(n: number): string;

  /**
   * Seconds as elapsed time: `'0:07'`, `'3:07'`, `'1:03:07'`. Hours appear only
   * when there are hours; seconds are floored, so a scrubber never reads one
   * second longer than the media it is playing.
   */
  export function formatDuration(seconds: number): string;

  /**
   * A timestamp as a wall clock in the user's locale: `'15:04:05'`. 24-hour by
   * choice (log lines and save times are a column, not prose), locale-decided
   * separators — never a hardcoded locale. `{ seconds: false }` gives `'15:04'`
   * for a "Saved 15:04" label.
   */
  export function formatClock(ts: number | Date, opts?: { seconds?: boolean }): string;

  /** Anything `toWebP` can encode from. A URL string is fetched first. */
  export type ImageSource =
    | Blob
    | ImageBitmap
    | HTMLCanvasElement
    | OffscreenCanvas
    | HTMLImageElement
    | HTMLVideoElement
    | string;

  export interface EncodeImageOptions {
    /**
     * Encoder quality, 0-1. Default 0.9. Ignored by lossless encoders
     * (`image/png`), and WebP treats 1 as lossless.
     */
    quality?: number;
    /**
     * Cap on the longest edge, in pixels. Downscale only — a smaller image is
     * never enlarged to meet it. Omit to keep the source's dimensions.
     */
    maxSize?: number;
    /** Output format. Default `image/webp`. */
    type?: 'image/webp' | 'image/png' | 'image/jpeg';
  }

  export interface EncodedImage {
    blob: Blob;
    /** Base64 *without* a data-URL prefix — what `appStorage.save(..., 'base64')` wants. */
    base64: string;
    /** The same bytes as a `data:` URL, for `<img src>` and content blocks. */
    dataUrl: string;
    bytes: number;
    width: number;
    height: number;
    mimeType: string;
  }

  /**
   * Re-encode an image, by default to WebP. Use this rather than hand-rolling
   * a canvas round-trip — no `@bundled/*` package ships a WebP codec because
   * Chromium already has one, and this is the boilerplate around it.
   *
   * Returns `null` rather than throwing when the browser cannot do it: an
   * undecodable source, a canvas with no 2D context, or an encoder that
   * declined the format and quietly handed back PNG. Callers have a sensible
   * fallback for that (keep the original bytes); a rejected promise would put
   * a try/catch around the common case.
   *
   * ```ts
   * const shot = await toWebP(canvas, { maxSize: 1024 });
   * if (shot) await appStorage.save('shots/latest.webp', shot.base64, { encoding: 'base64' });
   * ```
   *
   * A cross-origin image drawn without CORS taints the canvas and makes the
   * encode throw — you get `null`. Fetch it via `httpFetch` and pass the Blob.
   */
  export function toWebP(
    source: ImageSource,
    opts?: EncodeImageOptions,
  ): Promise<EncodedImage | null>;

  // ── The platform's fonts ──────────────────────────────────────

  export interface YaarServedFace {
    family: string;
    /** CSS `font-weight` this file answers for. */
    weight: number;
    style: 'normal' | 'italic';
    /** Where the full face can be fetched, same-origin. */
    url: string;
    /** True when the family is monospaced — what a code block should ask for. */
    mono: boolean;
  }

  export interface YaarFontCatalog {
    families: Array<{ family: string; mono: boolean; weights: number[] }>;
    faces: YaarServedFace[];
    /** `@font-face` rules pointing at the full files, by URL. */
    css: string;
  }

  export interface YaarFontMetrics {
    unitsPerEm: number;
    /** Typographic ascent/descent in font units; descent is negative. */
    ascent: number;
    descent: number;
    capHeight: number;
    /** [xMin, yMin, xMax, yMax] in font units. */
    bbox: [number, number, number, number];
  }

  export interface YaarInlinedFace {
    family: string;
    /** The weight you asked for — key your CSS by this. */
    weight: number;
    /** The weight actually served, when CSS matching landed on another file. */
    servedWeight: number;
    style: 'normal' | 'italic';
    /** PostScript-style name for a PDF `/BaseFont`. */
    baseFont: string;
    /** The subsetted face as a `data:` URL. */
    dataUrl: string;
    bytes: number;
    /** Glyphs carried, excluding `.notdef`. */
    glyphs: number;
    outlines: 'cff' | 'glyf';
    /** Base64 `CFF ` table, when `outlineTable` was asked for. */
    outlineTableBase64?: string;
    /** Character -> glyph id. A character the face lacks is absent. */
    gids: Record<string, number>;
    /** Character -> advance width, in font units. */
    advances: Record<string, number>;
    metrics: YaarFontMetrics;
  }

  export interface YaarInlinedFonts {
    /** `@font-face` rules carrying the subsets inline. */
    css: string;
    faces: YaarInlinedFace[];
    /**
     * Characters no returned face has a glyph for. Not an error — what to do
     * about them is a decision only the caller can make.
     */
    missing: string[];
  }

  export interface InlineFontsOptions {
    /** Family to subset. Defaults to the first proportional family served. */
    family?: string;
    /**
     * CSS weights to cover, e.g. `[400, 700]`. Each is resolved by CSS font
     * matching against the files served. Defaults to `[400]`.
     */
    weights?: number[];
    /**
     * Also return the raw CFF table for a PDF `/FontFile3`. Roughly doubles the
     * response; only a caller embedding glyphs in a PDF wants it.
     */
    outlineTable?: boolean;
  }

  /**
   * The fonts YAAR ships, in the form a *picture* of your DOM needs them.
   *
   * An app's own DOM already gets the platform webfont for free. This is for the
   * moment you rasterise that DOM (SVG `foreignObject` -> `img` -> canvas):
   * Chrome draws such an image in secure static mode, where a webfont cannot be
   * fetched at all and only a `data:` URL `@font-face` is honoured. A whole face
   * is ~1.6 MB, so it has to be subsetted first — which is what `inline()` does,
   * on the server, in one call.
   *
   * ```ts
   * const { css, missing } = await fonts.inline(pageEl.textContent, { weights: [400, 700] });
   * // …put `css` inside the SVG's <style>, alongside your own rules.
   * ```
   *
   * The same result carries `gids`, `advances` and `metrics`, so a caller also
   * writing a PDF over that raster paints the *same* glyphs the picture used.
   * Getting those from a second call risks a different subset, and a raster laid
   * out with one font under text placed with another drifts by ~10% on Latin.
   *
   * Needs no permission — the font files are already served unauthenticated.
   *
   * For the whole pipeline rather than just the fonts, see `rasterize`.
   */
  export const fonts: {
    /** The faces this build serves, with the by-URL `@font-face` rules. */
    faces(): Promise<YaarFontCatalog>;
    /**
     * `@font-face` rules pointing at the full files, for a *measuring* pass.
     * Measure against these, rasterise with `inline()` — the subset keeps every
     * glyph index and metrics table identical, so the measurements stay valid.
     */
    faceCss(family?: string): Promise<string>;
    /**
     * Subset the platform's faces down to `text` and return them inline.
     *
     * Pass the *whole* page's text, not a sample: a character left out renders
     * in a fallback face. Only distinct characters count, up to 5000 per call.
     */
    inline(text: string, opts?: InlineFontsOptions): Promise<YaarInlinedFonts>;
  };

  // ── Rasterizing your own DOM ──────────────────────────────────

  export interface RasterizeFontOptions {
    /** Family to embed. Defaults to the first proportional family YAAR serves. */
    family?: string;
    /**
     * Weights to embed. Defaults to the weights the subtree actually computes
     * to, so a page of plain body text pays for one face rather than four.
     */
    weights?: number[];
    /** Characters to cover. Defaults to the subtree's text. */
    text?: string;
  }

  export interface RasterizeOptions {
    /**
     * The stylesheet the picture carries. Required in practice: the subtree
     * reaches none of the page's CSS, so anything not stated here is missing
     * from the result.
     */
    css?: string;
    /** Source box in CSS pixels. Defaults to the element's own bounding rect. */
    width?: number;
    height?: number;
    /**
     * Device pixels per CSS pixel. Default 2 — real sharpness for CJK and code.
     * The canvas costs `width * height * 4 * scale²` bytes.
     */
    scale?: number;
    /** Output format. Default `image/png`. */
    type?: 'image/png' | 'image/jpeg' | 'image/webp';
    /** Encoder quality, 0–1, for the lossy formats. Default 0.92. */
    quality?: number;
    /**
     * Painted before the subtree. JPEG has no alpha, so without this every
     * transparent pixel encodes as **black**. Defaults to white for
     * `image/jpeg`, transparent otherwise.
     */
    background?: string;
    /** Embed YAAR's webfonts as a `data:` URL `@font-face`. `false` to skip. */
    fonts?: RasterizeFontOptions | false;
    /** Rewrite every `<img src>` to a `data:` URL first. Default true. */
    inlineImages?: boolean;
  }

  export interface RasterizeResult {
    blob: Blob;
    /** The canvas, so a caller wanting pixels does not rasterise twice. */
    canvas: HTMLCanvasElement;
    /** Device pixels. */
    width: number;
    height: number;
    /** What `fonts.inline()` returned, or null when fonts were skipped. */
    fonts: YaarInlinedFonts | null;
    /** Image sources that could not be inlined, so those boxes are empty. */
    skippedImages: string[];
  }

  /**
   * Rasterise a laid-out element to an image.
   *
   * ```ts
   * const { blob } = await rasterize(pageEl, { css: exportCss, scale: 2 });
   * downloadBlob(blob, 'page.png');
   * ```
   *
   * The element must be **in the document and laid out** —
   * `position:fixed; left:-99999px` is the usual trick, since a `display:none`
   * subtree has no metrics and rasterises as nothing. It is cloned, so the live
   * DOM is not touched.
   *
   * The rasterised subtree **inherits nothing**: no page stylesheet, no
   * `--yaar-*` tokens, no network. Whatever the picture needs ships in `css`.
   * Fonts, images and the XML/tainting traps are handled for you.
   */
  export function rasterize(
    element: HTMLElement,
    opts?: RasterizeOptions,
  ): Promise<RasterizeResult>;

  /**
   * Register a keyboard shortcut. Returns a cleanup function.
   *
   * Combo format: modifier keys joined with `+`, e.g. `"ctrl+s"`, `"alt+arrowup"`, `"escape"`.
   * `ctrl` matches both Ctrl and Cmd (Meta) for cross-platform shortcuts.
   */
  export function onShortcut(combo: string, handler: (e: KeyboardEvent) => void): () => void;

  export interface KeyStateOptions {
    /**
     * Keys whose default browser action is suppressed — e.g. `['arrowup', ' ']`
     * so movement keys never scroll the window. Matched against `e.key` or
     * `e.code`, case-insensitive.
     */
    preventDefault?: string[];
    /**
     * Skip presses landing in an editable element (input, textarea, select,
     * contenteditable), so typing "w" into a chat box never moves the player.
     * Defaults to true. Releases are always processed.
     */
    ignoreEditable?: boolean;
  }

  export interface KeyState {
    /**
     * True while `key` is held. Matched against `KeyboardEvent.key` (`'w'`,
     * `'arrowleft'`, `' '`) or `KeyboardEvent.code` (`'KeyW'`, `'Space'` —
     * layout-independent), case-insensitive.
     */
    has(key: string): boolean;
    /** Forget everything currently held (keys stay untracked until re-pressed). */
    clear(): void;
    /** Remove all listeners and clear the held set. */
    dispose(): void;
  }

  /**
   * Track which keys are held right now — the input half of a game loop.
   * Declarative `keybindings` / `onShortcut` fire discrete actions on keydown;
   * continuous movement instead samples `keys.has('w')` every animation frame.
   *
   * Handles the fiddly parts: OS auto-repeat ignored, held state cleared on
   * window blur and tab-hide (no stuck keys after alt-tab), releases keyed by
   * `e.code` so a modifier changing `e.key` mid-hold never wedges a key.
   */
  export function createKeyState(options?: KeyStateOptions): KeyState;

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
   *
   * `debounceMs` coalesces a burst of sets into one write, and is off by default.
   * Reach for it when the signal is bound to a **text input** — `onInput` fires
   * per keystroke, and an IME per composition step, so one typed name is a dozen
   * writes. Leave it off for a toggle, where a set is a click. A pending write is
   * flushed when the page is hidden or unloaded, so closing mid-debounce saves.
   *
   * The third element, `ready`, resolves once the initial load settles, with the
   * value the signal then holds. A value only *rendered* can ignore it — the late
   * load re-renders. A value that decides a **one-shot side effect** must await it,
   * or that effect runs on the fallback and cannot be taken back:
   *
   * ```js
   * const [mode, setMode, modeReady] = createPersistedSignal('prefs/mode.json', false);
   * onMount(async () => { await modeReady; void loadFeed(mode()); });
   * ```
   *
   * It never rejects, and a set that landed first still wins.
   */
  export function createPersistedSignal<T>(
    key: string,
    fallback: T,
    options?: {
      label?: string;
      onError?: (message: string, error: unknown) => void;
      revive?: (raw: unknown) => T;
      /** Coalesce a burst of sets into one write. Default 0 (write on every set). */
      debounceMs?: number;
    },
  ): [get: () => T, set: (v: T | ((prev: T) => T)) => void, ready: Promise<T>];

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
    /** Consulted by `open()`. False cancels the pending fold without expanding. */
    canOpen?: () => boolean;
    /** Consulted when the fold fires. True keeps the panel open (re-arm to retry). */
    holdOpen?: () => boolean;
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
// Require the matching name in app.json "bundles" (e.g. ["yaar-dev"]) to import.

declare module '@bundled/yaar-dev' {
  export function compile(path: string, opts?: { title?: string }): Promise<YaarDevCompileResult>;
  export function typecheck(path: string): Promise<YaarDevTypecheckResult>;
  /**
   * Format source text with the host's prettier, in the repo's own style.
   *
   * Text in, text out: the server opens no file and writes none. `path` is read for
   * its extension (which parser to use) — write the result back yourself, so your own
   * history and buffers stay true. Formats .ts/.tsx/.mts/.cts, .js/.jsx/.mjs/.cjs,
   * .json and .css.
   */
  export function format(path: string, source: string): Promise<YaarDevFormatResult>;
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
   * Check `ok` first; on success the payload is `data` — a formatted page-state
   * summary (a string) for most actions, structured JSON for the ones whose
   * signature says so. An HTTP failure rejects instead.
   */
  export type WebResult<T = string> = { ok: true; data: T } | { ok: false; error: string };

  /** The envelope of an action that returns a picture (`screenshot`, `extractImages`). */
  export type WebImageResult =
    | {
        ok: true;
        text: string;
        images: Array<{ data: string; mimeType: string; src?: string }>;
      }
    | { ok: false; error: string };

  /** One open tab, as `listTabs()` reports it. */
  export interface WebTab {
    id: string;
    url: string;
    title: string;
    mobile: boolean;
    /** The desktop window showing this tab, when one is open. */
    windowId?: string;
    /** Present when the tab is pointed at YAAR itself. */
    isSelf?: true;
  }

  /** What `scrollToBottom()` answers. */
  export interface WebScrollToBottomResult {
    steps: number;
    finalHeight: number;
    reachedBottom: boolean;
  }

  /** What `html({ includeMeta: true })` answers. */
  export interface WebHtmlWithMeta {
    html: string;
    url: string;
    title: string;
    readyState: string;
  }

  /** One element the `annotate()` overlay numbered. */
  export interface WebAnnotatedElement {
    index: number;
    tag: string;
    text: string;
    href?: string | null;
    selector?: string | null;
    x: number;
    y: number;
  }

  /** One cookie, as `getCookies()` reports it. */
  export interface WebCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }

  /** Create a new browser tab without navigating. */
  export function create(opts?: {
    browserId?: string;
    mobile?: boolean;
    visible?: boolean;
    /**
     * Open the window already in live mode — the screencast the toolbar's ◉ Live
     * button turns on, which the user can drive with mouse and keyboard. Only
     * meaningful alongside `visible`; ignored when no window is opened. Use it for
     * flows a human has to finish by hand (login, OTP, captcha) so they are not
     * left to find the toggle themselves.
     */
    live?: boolean;
  }): Promise<WebResult>;
  /** List all open browser tabs. */
  export function listTabs(): Promise<WebResult<WebTab[]>>;
  /** Close a browser tab. */
  export function closeTab(browserId?: string): Promise<WebResult>;

  // ── Navigation ─────────────────────────────────────────────────
  /** Open a URL (creates tab if needed, reuses if exists). */
  export function open(
    url: string,
    opts?: {
      browserId?: string;
      mobile?: boolean;
      visible?: boolean;
      /**
       * Open the window already in live mode — the screencast the toolbar's ◉ Live
       * button turns on, which the user can drive with mouse and keyboard. Only
       * meaningful alongside `visible`; ignored when no window is opened. Use it for
       * flows a human has to finish by hand (login, OTP, captcha) so they are not
       * left to find the toggle themselves.
       */
      live?: boolean;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    },
  ): Promise<WebResult>;
  /** Navigate to a URL or go back/forward in history. */
  export function navigate(url: string, browserId?: string): Promise<WebResult>;
  export function navigate(opts: {
    direction: 'back' | 'forward';
    browserId?: string;
  }): Promise<WebResult>;
  /** Scroll by `amount` pixels (default 500) in one step. */
  export function scroll(opts: {
    direction: 'up' | 'down';
    amount?: number;
    browserId?: string;
  }): Promise<WebResult>;
  /**
   * Scroll to the bottom one viewport at a time, dwelling after each step so
   * lazy-loaded content can extend the page. Stops when the document height
   * stops growing or `maxSteps` (default 40) is reached.
   *
   * `data` is `{ steps, finalHeight, reachedBottom }`.
   */
  export function scrollToBottom(opts?: {
    maxSteps?: number;
    /** Pause after each step, ms (default 400). Raise it for slow loaders. */
    dwellMs?: number;
    browserId?: string;
  }): Promise<WebResult<WebScrollToBottomResult>>;

  // ── Interaction ────────────────────────────────────────────────
  export function click(opts: {
    selector?: string;
    text?: string;
    x?: number;
    y?: number;
    index?: number;
    browserId?: string;
  }): Promise<WebResult>;
  export function type(opts: {
    selector: string;
    text: string;
    browserId?: string;
  }): Promise<WebResult>;
  export function press(opts: {
    key: string;
    selector?: string;
    browserId?: string;
  }): Promise<WebResult>;
  export function hover(opts: {
    selector?: string;
    text?: string;
    x?: number;
    y?: number;
    browserId?: string;
  }): Promise<WebResult>;

  // ── Shield ─────────────────────────────────────────────────────
  //
  // The server half of ad/popup blocking. Both settings are PROVIDER-WIDE: they
  // apply to every tab now open and to every tab Chrome opens later (a popup is
  // adopted into the same profile), which is what makes them useful against a
  // popunder — the tab the ad opened is shielded before its first script runs.
  // `browserId` is accepted for uniformity and ignored.

  /**
   * Refuse matching requests at the network layer (`Network.setBlockedURLs`), so
   * the bytes never arrive and the tracker is never pinged. `hosts` are suffix
   * rules (`doubleclick.net` also blocks `ad.doubleclick.net`), `urlPatterns` are
   * substrings of the full URL, `patterns` are raw Chrome wildcard patterns.
   * `enabled: false` clears everything.
   */
  export function setRequestBlocking(opts: {
    enabled: boolean;
    rules?: { hosts?: string[]; urlPatterns?: string[]; patterns?: string[] };
    browserId?: string;
  }): Promise<WebResult<{ enabled: boolean; ruleCount: number }>>;
  /** Per-tab counters since the tab's socket came up. */
  export function getRequestBlockStats(opts?: {
    browserId?: string;
  }): Promise<WebResult<{ blocked: number; requests: number; enabled: boolean }>>;
  /**
   * Source evaluated BEFORE any page script, on every navigation, in every tab
   * (`Page.addScriptToEvaluateOnNewDocument`). The only way to override
   * `window.open` ahead of a page that binds it on load. Empty string clears.
   */
  export function setInitScript(opts: {
    script: string;
    browserId?: string;
  }): Promise<WebResult<{ installed: boolean }>>;

  // ── Network log ────────────────────────────────────────────────
  //
  // What a tab fetched — metadata only, no headers or bodies. PER TAB (a request
  // belongs to the page that made it) and always on: the last 500 requests are
  // kept across navigations, oldest evicted first.

  export interface NetworkLogEntry {
    /** Monotonic per tab; pass the result's `lastSeq` back as `afterSeq` to poll. */
    seq: number;
    /** Chrome's request id; a redirect chain shares one. */
    requestId: string;
    url: string;
    method: string;
    /** CDP resource type: Document, XHR, Fetch, Media, Script, Image, Font, ... */
    resourceType: string;
    /** The page that issued it — filter on this for one navigation's traffic. */
    documentUrl: string;
    /** Epoch ms. */
    startedAt: number;
    status?: number;
    mimeType?: string;
    redirectedTo?: string;
    fromCache?: boolean;
    /** Bytes on the wire. */
    size?: number;
    durationMs?: number;
    /** Chrome's error text when the request did not complete. */
    failed?: string;
    /** Refused by `setRequestBlocking`. */
    blocked?: boolean;
    /** The `url` was cut at `maxUrlLength`; query again with `maxUrlLength: 0` for all of it. */
    urlTruncated?: boolean;
  }

  /**
   * The tab's recent requests, newest last. `urlPattern` is a substring, or a
   * wildcard pattern when it contains `*`. `limit` defaults to 50 (max 200);
   * `totalMatched` says how many there were before the slice. URLs are cut to
   * 300 characters unless `maxUrlLength: 0` — a signed CDN URL is kilobytes, and
   * a caller that intends to re-fetch one (through `yaar://http`) needs it whole.
   */
  export function getNetworkLog(opts?: {
    urlPattern?: string;
    resourceType?: string | string[];
    failedOnly?: boolean;
    afterSeq?: number;
    limit?: number;
    maxUrlLength?: number;
    browserId?: string;
  }): Promise<
    WebResult<{
      entries: NetworkLogEntry[];
      totalMatched: number;
      lastSeq: number;
      size: number;
      capacity: number;
    }>
  >;

  // ── Observation ────────────────────────────────────────────────
  export function waitFor(opts: {
    selector: string;
    timeout?: number;
    browserId?: string;
  }): Promise<WebResult>;
  export function screenshot(opts?: {
    x0?: number;
    y0?: number;
    x1?: number;
    y1?: number;
    browserId?: string;
  }): Promise<WebImageResult>;
  export function extract(opts?: {
    selector?: string;
    mainContentOnly?: boolean;
    maxTextLength?: number;
    maxLinks?: number;
    browserId?: string;
  }): Promise<WebResult>;
  export function extractImages(opts?: {
    selector?: string;
    mainContentOnly?: boolean;
    minWidth?: number;
    minHeight?: number;
    extensions?: string[];
    browserId?: string;
  }): Promise<WebImageResult>;
  /**
   * Page HTML, in `data`.
   *
   * The default is `document.body.innerHTML` — a FRAGMENT. There is no doctype,
   * no `<head>`, no `<title>`, and no page metadata of any kind. Do not feed it
   * to a parser expecting a document, and do not read a title out of it.
   *
   * - `outerHTML: true` — include the element's own tag; with no selector that
   *   is the whole `<html>` element (still no doctype).
   * - `includeMeta: true` — `data` becomes `{ html, url, title, readyState }`
   *   instead of a bare string. This is the only way to learn which URL the
   *   HTML actually came from.
   */
  export function html(opts?: {
    selector?: string;
    outerHTML?: boolean;
    includeMeta?: boolean;
    browserId?: string;
  }): Promise<WebResult<string | WebHtmlWithMeta>>;
  /**
   * Evaluate an expression in the page; `data` is its JSON value (null when it had none).
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
  }): Promise<WebResult<unknown>>;

  // ── Visual ─────────────────────────────────────────────────────
  export function annotate(browserId?: string): Promise<WebResult<WebAnnotatedElement[]>>;
  export function removeAnnotations(browserId?: string): Promise<WebResult>;

  // ── Cookies ────────────────────────────────────────────────────
  export function getCookies(opts?: {
    urls?: string[];
    browserId?: string;
  }): Promise<WebResult<WebCookie[]>>;
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
  }): Promise<WebResult>;
  export function deleteCookies(opts: {
    name: string;
    domain?: string;
    path?: string;
    url?: string;
    browserId?: string;
  }): Promise<WebResult>;

  // ── Deprecated ─────────────────────────────────────────────────
  /** @deprecated Use `listTabs()` instead. */
  export function listSessions(): Promise<WebResult<WebTab[]>>;
  /** @deprecated Use `closeTab()` instead. */
  export function closeSession(browserId?: string): Promise<WebResult>;
}

declare module '@bundled/yaar-media' {
  // Media download via the server's OPTIONAL yt-dlp binary (yaar://system/ytdlp).
  // Requires "bundles": ["yaar-media"] in app.json — the bundle alone grants the
  // capability at the verb door; no permissions entry is needed (a declared
  // yaar://system/ytdlp grants nothing). Check `ytdlpStatus()` first: when yt-dlp
  // is not installed on the machine, `available` is false and actions refuse with
  // install guidance to show the user.
  //
  // Downloads always land at yaar://storage/shared/media/{videoId}.{ext} — the
  // server picks the path — readable by every app with plain storage calls.
  // YouTube URLs only (youtube.com / youtu.be / music.youtube.com).

  export interface YtDlpJob {
    id: string;
    url: string;
    stage: 'downloading' | 'saving' | 'done' | 'error' | 'cancelled';
    title?: string;
    durationSec?: number | null;
    /** Set when done: the finished file, e.g. `yaar://storage/shared/media/abc.m4a`. */
    uri?: string;
    bytes?: number;
    error?: string;
    startedAt: number;
    finishedAt?: number;
  }

  export interface YtDlpStatus {
    /** False when the yt-dlp binary is not installed on the server's machine. */
    available: boolean;
    version: string | null;
    binaryPath: string | null;
    /** Recent jobs, newest first. */
    jobs: YtDlpJob[];
  }

  export interface YtDlpAudioFormat {
    formatId: string;
    ext: string;
    acodec: string;
    abrKbps: number | null;
    filesizeBytes: number | null;
  }

  export interface YtDlpMediaInfo {
    id: string;
    title: string;
    channel: string | null;
    durationSec: number | null;
    webpageUrl: string;
    extractor: string;
    audioFormats: YtDlpAudioFormat[];
  }

  /** yt-dlp availability + the recent job table. Memory-only server-side; poll freely. */
  export function ytdlpStatus(): Promise<YtDlpStatus>;

  /** Metadata + audio-only format list for a YouTube URL. Blocking, no media bytes. */
  export function resolveMedia(url: string): Promise<YtDlpMediaInfo>;

  /** Start an audio download job and return its snapshot immediately (fire-and-forget). */
  export function startAudioDownload(url: string): Promise<YtDlpJob>;

  /** Cancel a running download job. */
  export function cancelDownload(jobId: string): Promise<YtDlpJob>;

  /**
   * Download a YouTube URL's best audio track and wait for completion.
   * Resolves with the finished job (`uri` names the file in shared/media/); rejects
   * on error/cancel/timeout — a timeout also cancels the job server-side.
   */
  export function downloadAudio(
    url: string,
    opts?: {
      /** Poll interval while waiting (default 2000ms). */
      pollMs?: number;
      /** Give up (and cancel the job) after this long (default 15 minutes). */
      timeoutMs?: number;
      /** Called with the job snapshot on every poll. */
      onUpdate?: (job: YtDlpJob) => void;
    },
  ): Promise<YtDlpJob>;
}

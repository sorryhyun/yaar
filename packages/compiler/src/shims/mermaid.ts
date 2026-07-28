/**
 * `@bundled/mermaid` — text-to-diagram rendering, wired to the YAAR design tokens.
 *
 * Mermaid is the one bundled library whose value is mostly *authoring*: an agent
 * writing `graph TD; A-->B` produces a laid-out diagram, where the same agent
 * writing d3 produces a layout bug. That is why the shim's job is to remove every
 * decision an app would otherwise have to make wrong.
 *
 * Four things it fixes, each of which bit somewhere before it was written once:
 *
 * 1. **Nothing runs at module scope.** `mermaid.initialize()` is called on the
 *    first render, not on import. `protocol/fold-schemas.ts` evaluates an app's
 *    entry module inside a Worker whose `document` is a stub — an app importing
 *    this shim must survive that, or declaring a Zod `params` anywhere in the app
 *    would fail the build with a DOM error from a library the protocol never
 *    touches.
 * 2. **Renders are serialized.** Mermaid's config is a module-global that
 *    `render()` reads *while* it runs. Two concurrent renders with different
 *    themes — one slide's diagram and its thumbnail, say — interleave, and the
 *    second theme silently wins for both. The queue below makes a render's own
 *    config the one it is drawn with.
 * 3. **`securityLevel` is forced to `'strict'` and is not an option.** That is
 *    what makes mermaid run DOMPurify over its own output and disables HTML
 *    labels, so a diagram label cannot carry markup into the page. Diagram source
 *    is untrusted content like any other — it arrives from a model or a user — and
 *    an app that could pass `securityLevel: 'loose'` eventually would. The output
 *    is therefore already sanitized when it is returned, and callers must not run
 *    it through `sanitizeHtml` again: that policy is tuned for HTML fragments and
 *    strips the `<style>` block mermaid emits inside the SVG to theme itself.
 * 4. **Error diagrams never reach the document.** With `suppressErrorRendering`
 *    unset, a syntax error makes mermaid append a "Syntax error in text" SVG to
 *    `document.body` — outside the app's own tree, where nothing cleans it up.
 *    Here a bad diagram rejects, and the caller decides what the user sees.
 *
 * Theme values are read from the live CSS custom properties the compiler injects
 * rather than imported from `tokens.ts`, so a diagram follows the tokens actually
 * in force — including an app that overrides them locally, which is exactly what
 * a slide deck with its own palette does.
 */

import mermaid from 'mermaid';

export type { MermaidConfig, RenderResult } from 'mermaid';

/**
 * Palette for one diagram, in YAAR's vocabulary rather than mermaid's ~140
 * `themeVariables`. Anything omitted falls back to the design token of the same
 * role. An app with its own palette (a slide theme, a printed export) passes the
 * colors it already has and gets a diagram that matches.
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

/** Fallbacks used when the tokens are unreadable (no DOM, or an unstyled document). */
const TOKEN_FALLBACKS: Record<string, string> = {
  '--yaar-bg': '#161b22',
  '--yaar-bg-surface': '#1c2128',
  '--yaar-text': '#f0f6fc',
  '--yaar-text-muted': '#adbac7',
  '--yaar-accent': '#539bf5',
  '--yaar-border': '#373e47',
  '--yaar-font': 'system-ui, sans-serif',
  '--yaar-text-base': '14px',
};

function token(name: string): string {
  const fallback = TOKEN_FALLBACKS[name] ?? '';
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    // No DOM (the schema fold's Worker) or a detached document.
    return fallback;
  }
}

/**
 * Mermaid's `base` theme derives the rest of its palette from these, so setting
 * the handful that carry meaning is enough — enumerating all ~140 would freeze
 * this shim against mermaid's own theme evolution.
 */
function themeVariables(overrides: MermaidThemeInput = {}): Record<string, string> {
  const background = overrides.background ?? token('--yaar-bg');
  const surface = overrides.surface ?? token('--yaar-bg-surface');
  const text = overrides.text ?? token('--yaar-text');
  const muted = overrides.muted ?? token('--yaar-text-muted');
  const accent = overrides.accent ?? token('--yaar-accent');
  const border = overrides.border ?? token('--yaar-border');

  return {
    darkMode: 'true',
    background,
    // Nodes.
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: accent,
    mainBkg: surface,
    nodeBorder: accent,
    nodeTextColor: text,
    // Edges. `lineColor` is muted rather than `border` on purpose: a border tuned
    // to separate two adjacent surfaces is too low-contrast to read as an arrow
    // drawn across open canvas.
    lineColor: muted,
    textColor: text,
    titleColor: text,
    edgeLabelBackground: background,
    // Clusters / subgraphs.
    secondaryColor: background,
    tertiaryColor: background,
    clusterBkg: background,
    clusterBorder: border,
    // Notes — mermaid's defaults here are a fixed yellow that ignores the theme.
    noteBkgColor: surface,
    noteTextColor: text,
    noteBorderColor: border,
    fontFamily: overrides.fontFamily ?? token('--yaar-font'),
    fontSize: overrides.fontSize ?? token('--yaar-text-base'),
  };
}

function config(options: RenderMermaidOptions) {
  return {
    startOnLoad: false,
    // Not an option — see the header. Forces mermaid's own DOMPurify pass and
    // disables HTML labels.
    securityLevel: 'strict' as const,
    suppressErrorRendering: true,
    theme: 'base' as const,
    themeVariables: themeVariables(options.theme),
    look: options.look ?? ('classic' as const),
    flowchart: { useMaxWidth: true },
  };
}

let idSeq = 0;

/**
 * Mermaid interpolates the id into both a DOM id and the CSS selectors of the
 * `<style>` block it embeds, so anything outside `[A-Za-z0-9_-]` produces an SVG
 * whose own rules do not match it — a diagram that renders unstyled rather than
 * failing.
 */
function safeId(raw: string | undefined): string {
  const cleaned = (raw ?? '').replace(/[^A-Za-z0-9_-]/g, '-');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `yaar-mermaid-${++idSeq}`;
}

/**
 * Serializes access to mermaid's global config. Failures do not break the chain:
 * the next caller runs regardless of whether the previous diagram parsed.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Render mermaid source to an `<svg>` string, already sanitized (see the header —
 * do not sanitize it again).
 *
 * Rejects on a syntax error rather than returning an error diagram, so a caller
 * can show the source, the message, or nothing at all.
 */
export async function renderMermaid(
  source: string,
  options: RenderMermaidOptions = {},
): Promise<string> {
  const text = typeof source === 'string' ? source.trim() : '';
  if (!text) throw new Error('renderMermaid: diagram source is empty');

  return serialize(async () => {
    mermaid.initialize(config(options));
    const id = safeId(options.id);
    try {
      const { svg } = await mermaid.render(id, text);
      return svg;
    } finally {
      // Mermaid renders into a temporary div appended to `document.body` and
      // removes it on success only; a throw leaves it behind, and they
      // accumulate one per failed keystroke in a live editor.
      try {
        document.getElementById(`d${id}`)?.remove();
      } catch {
        /* no DOM to clean up */
      }
    }
  });
}

/**
 * Whether the source parses, without rendering it. For an editor that wants to
 * mark a diagram invalid while it is being typed — cheaper than a full render,
 * and it never touches the document.
 */
export async function isValidMermaid(source: string): Promise<boolean> {
  const text = typeof source === 'string' ? source.trim() : '';
  if (!text) return false;
  return serialize(async () => {
    mermaid.initialize(config({}));
    try {
      return (await mermaid.parse(text, { suppressErrors: true })) !== false;
    } catch {
      return false;
    }
  });
}

/**
 * The upstream mermaid API, for the diagram types and config the helpers above
 * do not cover. An app reaching for this owns the consequences — in particular,
 * calling `initialize()` yourself replaces the security level and the theme for
 * every later `renderMermaid` call too, because the config is global.
 */
export default mermaid;

// @ts-nocheck — This file runs in browser iframes, not the server.
/**
 * `@bundled/lucide` — Lucide's icons as data, plus the one renderer every app wrote by hand.
 *
 * Five apps (image-edit, mesh-edit, studio-3d, word-excel, devtools) each carried an
 * `icons.ts` of Lucide-style path strings copied out of an agent's memory, rendered four
 * different ways (createElementNS, an SVG string through innerHTML, an `html` template
 * with innerHTML). A remembered path is a guessed path; a named export is not.
 *
 * Each icon is exported as its `IconNode` — `[tag, attrs][]` — so an app pays only for
 * the icons it imports. `icon()` turns one into a fresh SVG node. It takes any IconNode,
 * so an app's own domain glyphs (a mesh editor's "vertex" or "bevel") are written in the
 * same shape and rendered by the same call.
 *
 * Built with createElementNS, never markup: there is no innerHTML sink to copy, and a node
 * interpolated into a solid-js/html template is inserted as-is. Each call returns a new
 * element because a DOM node can sit in one place only.
 *
 * Also a barrel fix: lucide's ESM entry re-exports one module per icon, and a pure
 * re-export barrel prebundled directly collapses (see the compiler CLAUDE.md, Shims).
 *
 * Nothing runs at module scope: `protocol/fold-schemas.ts` evaluates an app's entry
 * module in a Worker with a stubbed `document`.
 */

export * from 'lucide';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(node, options = {}) {
  const size = String(options.size ?? 16);
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': String(options.strokeWidth ?? 2),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  if (options.class) svg.setAttribute('class', options.class);
  if (options.title) {
    svg.setAttribute('role', 'img');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = options.title;
    svg.appendChild(title);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  for (const [tag, shapeAttrs] of node) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(shapeAttrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

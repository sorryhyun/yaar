/**
 * Mermaid rendering for the desktop shell — the OS-side twin of the compiler's
 * `@bundled/mermaid` shim (`packages/compiler/src/shims/mermaid.ts`).
 *
 * The two are deliberately separate modules rather than one shared one, because
 * they read *different* token sets: an app iframe gets `--yaar-*` custom
 * properties injected by the compiler, while the shell's `tokens.css` publishes
 * `--color-*`. Pointing the shim at the shell would silently fall through to its
 * hardcoded fallbacks — the same GitHub-dark values, so it would look right —
 * and a diagram would then ignore both the light theme and the accent-preset
 * picker, which rewrite `--color-*` on `:root` at runtime.
 *
 * The four rules the shim learned are reproduced here because each of them is a
 * property of mermaid, not of the environment:
 *
 * 1. **Nothing runs at import.** `mermaid` is `import()`ed on the first diagram.
 *    It is 3.3 MB — by far the largest thing the desktop could load — and both
 *    builds run with `splitting: true`, so this lands in a chunk that a session
 *    which never renders a diagram never fetches.
 * 2. **Renders are serialized.** Mermaid's config is a module-global that
 *    `render()` reads *while* it runs, so two concurrent renders interleave and
 *    the later theme silently wins for both.
 * 3. **`securityLevel` is `'strict'`**, which is what makes mermaid run its own
 *    DOMPurify pass and disables HTML labels. Diagram source here comes from a
 *    model, so it is untrusted like any other content. The output is therefore
 *    already sanitized, and callers must **not** sanitize it again: DOMPurify
 *    strips the `<style>` block the SVG needs to theme itself.
 * 4. **`suppressErrorRendering`** keeps a syntax error from appending mermaid's
 *    "Syntax error in text" SVG to `document.body`, outside the React tree where
 *    nothing would ever clean it up. A bad diagram rejects and the caller decides
 *    what the user sees.
 */

/** Shell tokens, in the roles mermaid's `base` theme derives the rest from. */
function token(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

function isLight(): boolean {
  try {
    return document.documentElement.dataset.theme === 'light';
  } catch {
    return false;
  }
}

function themeVariables(): Record<string, string> {
  const background = token('--color-bg');
  const surface = token('--color-surface');
  const text = token('--color-text');
  const muted = token('--color-text-muted');
  const accent = token('--color-accent');
  const border = token('--color-border');

  return {
    darkMode: String(!isLight()),
    background,
    // Nodes.
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: accent,
    mainBkg: surface,
    nodeBorder: accent,
    nodeTextColor: text,
    // Edges. `lineColor` is the muted text color rather than the border color on
    // purpose: a border tuned to separate two adjacent surfaces is too
    // low-contrast to read as an arrow drawn across open canvas.
    lineColor: muted,
    textColor: text,
    titleColor: text,
    edgeLabelBackground: background,
    // Clusters / subgraphs.
    secondaryColor: background,
    tertiaryColor: background,
    clusterBkg: background,
    clusterBorder: border,
    // Notes — mermaid's own defaults here are a fixed yellow that ignores the theme.
    noteBkgColor: surface,
    noteTextColor: text,
    noteBorderColor: border,
    fontFamily: token('--font-sans'),
    fontSize: token('--text-base'),
  };
}

type MermaidApi = (typeof import('mermaid'))['default'];

let loading: Promise<MermaidApi> | null = null;

/** Loads mermaid on first use. A failed load is not cached, so a flaky chunk fetch can retry. */
function loadMermaid(): Promise<MermaidApi> {
  if (!loading) {
    loading = import('mermaid')
      .then((m) => m.default)
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

let idSeq = 0;

/**
 * Serializes access to mermaid's global config. A failure does not break the
 * chain: the next caller runs regardless of whether the previous diagram parsed.
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
 * Render mermaid source to an `<svg>` string, already sanitized (see rule 3 in
 * the header — do not sanitize it again).
 *
 * Rejects on a syntax error rather than returning an error diagram.
 *
 * The palette is read after `loadMermaid()` resolves, which matters on a theme
 * switch: `DesktopSurface` writes `data-theme` and the accent overrides from its
 * own effect, and a child component's effect runs *before* its parent's. Every
 * path to `themeVariables()` here crosses at least one `await`, so the read
 * happens in a microtask — after the whole effect flush, with the new palette on
 * `:root`.
 */
export async function renderMermaid(source: string): Promise<string> {
  const text = typeof source === 'string' ? source.trim() : '';
  if (!text) throw new Error('diagram source is empty');

  const mermaid = await loadMermaid();

  return serialize(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: themeVariables(),
      flowchart: { useMaxWidth: true },
    });
    const id = `yaar-mermaid-${++idSeq}`;
    try {
      const { svg } = await mermaid.render(id, text);
      return svg;
    } finally {
      // Mermaid renders into a temporary div appended to `document.body` and
      // removes it on success only; a throw leaves it behind, and they
      // accumulate one per failed keystroke while a diagram is streaming in.
      try {
        document.getElementById(`d${id}`)?.remove();
      } catch {
        /* no DOM to clean up */
      }
    }
  });
}

type CachedRender = { ok: true; svg: string } | { ok: false; message: string };

const renderCache = new Map<string, CachedRender>();
const CACHE_MAX = 32;

/**
 * `renderMermaid` keyed by `cacheKey` (palette + source), which is what makes a
 * streaming markdown window affordable: every appended token re-runs the whole
 * markdown pipeline, so an unchanged diagram would otherwise be laid out again
 * on each chunk. Failures are cached too — a diagram is *usually* invalid while
 * its fence is still arriving, and that half-written source repeats just as
 * often as a finished one.
 */
export async function renderMermaidCached(cacheKey: string, source: string): Promise<string> {
  const hit = renderCache.get(cacheKey);
  if (hit) {
    // Re-insert to mark it most-recently used.
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, hit);
    if (hit.ok) return hit.svg;
    throw new Error(hit.message);
  }

  let entry: CachedRender;
  try {
    entry = { ok: true, svg: await renderMermaid(source) };
  } catch (err) {
    entry = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  renderCache.set(cacheKey, entry);
  if (renderCache.size > CACHE_MAX) {
    const oldest = renderCache.keys().next();
    if (!oldest.done) renderCache.delete(oldest.value);
  }

  if (entry.ok) return entry.svg;
  throw new Error(entry.message);
}

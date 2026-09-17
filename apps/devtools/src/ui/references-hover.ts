export {};
import { createSignal, createEffect, on, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { errMsg } from '@bundled/yaar';
import { activeProject, fileChanges, openFilePath } from '../core';
import {
  identifierAt,
  isReferenceLookupPath,
  otherReferences,
  otherReferencesSummary,
  type IdentifierHit,
} from '../lib';
import { findReferences, openFile, type ReferencesResult } from '../services';
import { setPendingReveal, showFiles } from './panel-state';

// Hovering an identifier in the editor shows its references, from the same language-service
// lookup the `findReferences` command runs. The lookup reads the SAVED file, so positions are
// only trusted while the buffer is clean.

const HOVER_DELAY_MS = 400;
const HIDE_GRACE_MS = 200;
const POPOVER_WIDTH = 480;
const POPOVER_MAX_HEIGHT = 280;

type Lookup = Omit<ReferencesResult, 'success'>;

interface HoverBase {
  key: string;
  file: string;
  hit: IdentifierHit;
  style: string;
}
type HoverState =
  | (HoverBase & { kind: 'loading' })
  | (HoverBase & { kind: 'ready'; result: Lookup })
  | (HoverBase & { kind: 'error'; message: string })
  | (HoverBase & { kind: 'unsaved' });

const [hover, setHover] = createSignal<HoverState | null>(null);

// In-flight lookups are cached too, so a re-hover joins the pending request.
const cache = new Map<string, Promise<Lookup>>();
let requestToken = 0;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let pendingKey: string | null = null;

// Any write in the project can move references in any file, so the whole cache goes.
createEffect(
  on([fileChanges, activeProject], () => {
    cache.clear();
    hideReferences();
  }),
);
createEffect(on(openFilePath, () => hideReferences()));

export function hideReferences(): void {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  pendingKey = null;
  requestToken++;
  setHover(null);
}

function scheduleHide(): void {
  clearTimeout(showTimer);
  pendingKey = null;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideReferences, HIDE_GRACE_MS);
}

/** Text nodes of `root` in order, to map a text offset to a DOM position and back. */
function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/**
 * Caret offset into the highlighted code under a viewport point. The <textarea> sits on top
 * and is transparent, so the hit test has to see through it to the <pre> that lays the
 * same text out glyph for glyph.
 */
function caretAt(
  x: number,
  y: number,
  ta: HTMLElement,
  pre: HTMLElement,
): { node: Node; offset: number } | null {
  const taEvents = ta.style.pointerEvents;
  const preEvents = pre.style.pointerEvents;
  ta.style.pointerEvents = 'none';
  pre.style.pointerEvents = 'auto';
  try {
    const doc = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  } finally {
    ta.style.pointerEvents = taEvents;
    pre.style.pointerEvents = preEvents;
  }
}

function rangeFor(code: HTMLElement, start: number, end: number): Range | null {
  const range = document.createRange();
  let seen = 0;
  let startSet = false;
  for (const node of textNodes(code)) {
    const len = node.data.length;
    if (!startSet && start <= seen + len) {
      range.setStart(node, start - seen);
      startSet = true;
    }
    if (startSet && end <= seen + len) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += len;
  }
  return null;
}

function popoverStyle(anchor: DOMRect, overlay: HTMLElement): string {
  const box = overlay.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(anchor.left - box.left, box.width - Math.min(POPOVER_WIDTH, box.width - 16) - 8),
  );
  const top = anchor.bottom - box.top + 2;
  const roomBelow = box.height - top - 8;
  const roomAbove = anchor.top - box.top - 10;
  if (roomBelow >= POPOVER_MAX_HEIGHT || roomBelow >= roomAbove) {
    return `left: ${left}px; top: ${top}px; max-height: ${Math.min(POPOVER_MAX_HEIGHT, roomBelow)}px`;
  }
  const bottom = box.bottom - anchor.top + 2;
  return `left: ${left}px; bottom: ${bottom}px; max-height: ${Math.min(POPOVER_MAX_HEIGHT, roomAbove)}px`;
}

/**
 * Wire to the textarea's mousemove. `dirty` is whether the buffer differs from the saved
 * file — a lookup then would answer about positions that are not on screen.
 */
export function onEditorMouseMove(e: MouseEvent, dirty: boolean): void {
  const path = openFilePath();
  const proj = activeProject();
  const ta = e.currentTarget as HTMLTextAreaElement;
  const overlay = ta.parentElement;
  const pre = overlay?.querySelector<HTMLElement>('.editor-highlight');
  const code = pre?.querySelector<HTMLElement>('code');
  if (!path || !proj || !isReferenceLookupPath(path) || !overlay || !pre || !code) return;

  const caret = caretAt(e.clientX, e.clientY, ta, pre);
  if (!caret || !code.contains(caret.node)) return scheduleHide();
  if ((caret.node.parentElement as Element | null)?.closest('.token.comment, .token.string')) {
    return scheduleHide();
  }
  const prefix = document.createRange();
  prefix.setStart(code, 0);
  prefix.setEnd(caret.node, caret.offset);
  const text = code.textContent ?? '';
  const hit = identifierAt(text, prefix.toString().length);
  const range = hit ? rangeFor(code, hit.start, hit.end) : null;
  // A caret lands at the nearest glyph even past the end of a line, so confirm the pointer
  // is actually over the identifier's box.
  const anchor = range
    ? Array.from(range.getClientRects()).find(
        (r) =>
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom,
      )
    : undefined;
  if (!hit || !anchor) return scheduleHide();

  const key = `${proj.id}:${path}:${hit.line}:${hit.column}`;
  clearTimeout(hideTimer);
  if (hover()?.key === key || pendingKey === key) return;
  hideReferences();
  pendingKey = key;
  const token = requestToken;
  showTimer = setTimeout(() => {
    pendingKey = null;
    const base = { key, file: path, hit, style: popoverStyle(anchor, overlay) };
    if (dirty) return setHover({ ...base, kind: 'unsaved' });
    let lookup = cache.get(key);
    if (!lookup) {
      lookup = findReferences({ file: path, line: hit.line, column: hit.column });
      cache.set(key, lookup);
      // Failures (a timeout, a file mid-edit) are worth retrying on the next hover.
      lookup.catch(() => cache.delete(key));
    }
    setHover({ ...base, kind: 'loading' });
    lookup.then(
      (result) => {
        if (token === requestToken) setHover({ ...base, kind: 'ready', result });
      },
      (err: unknown) => {
        if (token === requestToken) setHover({ ...base, kind: 'error', message: errMsg(err) });
      },
    );
  }, HOVER_DELAY_MS);
}

export function onEditorMouseLeave(): void {
  scheduleHide();
}

async function goTo(file: string, line: number, column: number): Promise<void> {
  hideReferences();
  showFiles();
  setPendingReveal({ path: file, line, column });
  if (openFilePath() !== file) await openFile(file);
}

export function ReferencesPopover() {
  const ready = () => {
    const h = hover();
    return h?.kind === 'ready' ? h.result : null;
  };
  const others = () => {
    const h = hover();
    if (h?.kind !== 'ready') return null;
    return otherReferences(h.result, {
      file: h.file,
      line: h.hit.line,
      column: h.hit.column,
      length: h.hit.name.length,
    });
  };
  const errorMessage = () => {
    const h = hover();
    return h?.kind === 'error' ? h.message : null;
  };
  return html`
    <${Show} when=${hover}>
      <div
        class="refs-popover"
        style=${() => hover()?.style ?? ''}
        onMouseEnter=${() => clearTimeout(hideTimer)}
        onMouseLeave=${scheduleHide}
      >
        <div class="refs-header y-text-xs">
          <code class="refs-symbol">${() => ready()?.symbol ?? hover()?.hit.name}</code>
          <span class="y-text-muted">
            ${() => {
              const h = hover();
              if (!h) return '';
              if (h.kind === 'loading') return 'Finding references…';
              if (h.kind === 'unsaved')
                return 'Unsaved changes — references follow the saved file. Save (Ctrl+S) to look up.';
              if (h.kind === 'error') return '';
              const o = others();
              return o ? otherReferencesSummary(o.total, o.files, o.declaredHere) : '';
            }}
          </span>
        </div>
        <${Show} when=${errorMessage}>
          <div class="refs-error y-text-xs">${errorMessage}</div>
        <//>
        <${Show} when=${() => (ready()?.ambiguous?.length ?? 0) > 0}>
          <div class="refs-note y-text-xs y-text-muted">
            Name matches ${() => ready()?.ambiguous?.length} other declaration(s); showing the one under the cursor.
          </div>
        <//>
        <${Show} when=${() => others()?.declaredHere}>
          <div class="refs-note y-text-xs y-text-muted">Declared here</div>
        <//>
        <${Show} when=${() => (others()?.declaredHere ? null : others()?.definition)}>
          ${(def: () => NonNullable<NonNullable<ReturnType<typeof others>>['definition']>) => html`
            <button
              type="button"
              class="refs-item refs-definition y-text-xs"
              title=${() => `${def().file}:${def().line}:${def().column}`}
              onClick=${() => goTo(def().file, def().line, def().column)}
            >
              <span class="refs-loc">
                Defined at ${() => `${def().file}:${def().line}`}
              </span>
            </button>
          `}
        <//>
        <${Show} when=${ready}>
          <div class="refs-list y-scroll">
            <${For} each=${() => others()?.references ?? []}>
              ${(ref: NonNullable<ReturnType<typeof others>>['references'][number]) => html`
                <button
                  type="button"
                  class="refs-item y-text-xs"
                  title=${`${ref.file}:${ref.line}:${ref.column}`}
                  onClick=${() => goTo(ref.file, ref.line, ref.column)}
                >
                  <span class="refs-loc">
                    ${`${ref.file}:${ref.line}`}
                    ${ref.role ? html`<span class="refs-tag">${ref.role}</span>` : ''}
                  </span>
                  <span class="refs-text y-truncate">${ref.text}</span>
                  ${ref.enclosing ? html`<span class="refs-enclosing y-text-dim y-truncate">${ref.enclosing}</span>` : ''}
                </button>
              `}
            <//>
          </div>
          <${Show} when=${() => ready()?.truncated}>
            <div class="refs-note y-text-xs y-text-muted">List clipped at the result cap.</div>
          <//>
        <//>
      </div>
    <//>
  `;
}

/**
 * imgComments.ts — collapsible per-image comment (짤방댓글) UI.
 *
 * The post body is injected as raw HTML (not a Solid tree), so this attaches to
 * it imperatively: after each image that has comments, insert a toggle button
 * and a collapsed panel. Images with no comments get nothing at all, so a post
 * without image comments looks exactly as it does today.
 *
 * Data flow: the count comes from the body HTML itself (stamped onto the <img>
 * by the fetcher) so buttons label correctly with zero network calls. The
 * comment bodies are fetched lazily on the first open, once for the whole post.
 */
import { state } from '../store';
import { loadImageComments } from '../actions';
import { IMGC_FILENO_ATTR, IMGC_COUNT_ATTR } from '../fetcher';
import type { ImgComment } from '../types';

type Entry = {
  fileno: string;
  count: number;
  wrap: HTMLDivElement;
  btn: HTMLButtonElement;
  label: HTMLSpanElement;
  panel: HTMLDivElement;
  open: boolean;
  rendered: boolean;
  previewApplied: boolean;
};

export type ImgCommentsController = {
  entries: Entry[];
  /** True if this body has at least one image with comments. */
  hasAny: boolean;
};

/**
 * Choose the node the toggle is inserted after. DC wraps body images in
 * `.imgwrap` or a bare `<p>`; anchoring to the wrapper keeps the button
 * visually attached to the image instead of landing inside the wrapper's
 * layout. Only hoist when the wrapper holds the image alone -- if it also
 * carries author text, that text must stay above the button.
 */
function insertionAnchor(img: HTMLImageElement): Element {
  const parent = img.parentElement;
  if (parent && (parent.classList.contains('imgwrap') || parent.tagName === 'P')) {
    if (!(parent.textContent ?? '').trim()) return parent;
  }
  return img;
}

/** Build the collapsed toggle + panel for every image that has comments. */
export function setupImageComments(el: HTMLElement): ImgCommentsController {
  const entries: Entry[] = [];
  const imgs = Array.from(el.querySelectorAll(`img[${IMGC_FILENO_ATTR}]`)) as HTMLImageElement[];

  for (const img of imgs) {
    const fileno = (img.getAttribute(IMGC_FILENO_ATTR) ?? '').trim();
    const count = parseInt(img.getAttribute(IMGC_COUNT_ATTR) ?? '', 10) || 0;
    // Images without comments are never stamped, so they get no UI whatsoever.
    if (!fileno || count <= 0) continue;

    const wrap = document.createElement('div');
    wrap.className = 'imgc-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'imgc-toggle';
    btn.setAttribute('aria-expanded', 'false');

    const icon = document.createElement('span');
    icon.className = 'imgc-icon';
    icon.textContent = '💬';

    const label = document.createElement('span');
    label.className = 'imgc-label';
    label.textContent = `댓글 [${count}]`;

    const chev = document.createElement('span');
    chev.className = 'imgc-chev';
    chev.textContent = '▾';

    btn.append(icon, label, chev);

    const panel = document.createElement('div');
    panel.className = 'imgc-panel';
    panel.hidden = true;

    wrap.append(btn, panel);
    insertionAnchor(img).after(wrap);

    const entry: Entry = {
      fileno,
      count,
      wrap,
      btn,
      label,
      panel,
      open: false,
      rendered: false,
      previewApplied: false,
    };
    entries.push(entry);

    btn.addEventListener('click', () => {
      setOpen(entry, !entry.open);
      // Lazily pull the whole post's threads on the first open.
      if (entry.open) void loadImageComments();
    });
  }

  return { entries, hasAny: entries.length > 0 };
}

function setOpen(entry: Entry, open: boolean): void {
  entry.open = open;
  entry.panel.hidden = !open;
  entry.btn.classList.toggle('imgc-open', open);
  entry.btn.setAttribute('aria-expanded', String(open));
}

/** Render one comment row. Scraped text goes in via textContent, never HTML. */
function commentRow(c: ImgComment): HTMLElement {
  const row = document.createElement('div');
  row.className = 'imgc-item';

  const head = document.createElement('div');
  head.className = 'imgc-item-head';

  const author = document.createElement('span');
  author.className = 'imgc-author';
  if (c.nickType === 'gonick' || c.nickType === 'sub-gonick') author.classList.add('imgc-gonick');
  author.textContent = c.author;

  const date = document.createElement('span');
  date.className = 'imgc-date';
  date.textContent = c.date;

  head.append(author, date);

  const text = document.createElement('div');
  text.className = 'imgc-text';
  text.textContent = c.text;

  row.append(head, text);
  return row;
}

function renderPanel(entry: Entry): void {
  const panel = entry.panel;
  panel.textContent = '';

  if (state.imgCommentsLoading && !state.imgCommentsLoaded) {
    const loading = document.createElement('div');
    loading.className = 'imgc-status';
    const spinner = document.createElement('span');
    spinner.className = 'y-spinner';
    const txt = document.createElement('span');
    txt.textContent = '댓글 불러오는 중...';
    loading.append(spinner, txt);
    panel.append(loading);
    return;
  }

  if (state.imgCommentsError) {
    const err = document.createElement('div');
    err.className = 'imgc-status imgc-error';
    err.textContent = `댓글을 불러오지 못했습니다: ${state.imgCommentsError}`;
    panel.append(err);
    return;
  }

  if (!state.imgCommentsLoaded) return;

  const items = state.imgComments[entry.fileno] ?? [];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'imgc-status';
    empty.textContent = '댓글이 없습니다.';
    panel.append(empty);
    entry.rendered = true;
    return;
  }

  for (const c of items) panel.append(commentRow(c));
  entry.rendered = true;
}

/**
 * Push current store state into the mounted controls. Called from a reactive
 * effect so a finished fetch fills every panel the reader has open.
 */
export function syncImageComments(ctl: ImgCommentsController): void {
  // Read every reactive field up front so the effect subscribes to all of them.
  const loaded = state.imgCommentsLoaded;
  void state.imgCommentsLoading;
  void state.imgCommentsError;
  void state.imgComments;

  for (const entry of ctl.entries) {
    if (entry.open) renderPanel(entry);

    // Once loaded, fill in the real count and a short preview of the first
    // comment -- gives the reader a reason to open it.
    if (loaded && !entry.previewApplied) {
      const items = state.imgComments[entry.fileno] ?? [];
      if (items.length === 0) {
        // DC's data-comment flag claimed a thread but there is none (deleted, or
        // the flag was stale). Requirement 3: leave no empty UI behind.
        if (entry.count <= 0) {
          entry.wrap.remove();
          entry.previewApplied = true;
          continue;
        }
      } else {
        entry.count = items.length;
        const first = items[0].text;
        const preview = first.length > 18 ? `${first.slice(0, 18)}…` : first;
        entry.label.textContent = `댓글 [${entry.count}] · ${preview}`;
      }
      entry.previewApplied = true;
    }
  }
}

/** Open or close every thread at once (상단 전체 펼치기/접기). */
export function setAllOpen(ctl: ImgCommentsController, open: boolean): void {
  for (const entry of ctl.entries) setOpen(entry, open);
}

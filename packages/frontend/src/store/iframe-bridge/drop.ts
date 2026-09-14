/**
 * Drops onto a window — the one place that decides who receives them.
 *
 * A drop reaches the desktop two ways: onto the window frame (`useWindowDrop`), or onto an
 * app's content, which the frame never sees because drag events do not cross into an
 * iframe — the frame's own script hands those out as `yaar:file-drop`
 * (`iframe-scripts/contextmenu.ts`). Both land here, so a file dropped on the title bar and
 * one dropped on the canvas below it cannot mean different things.
 *
 * Who receives it: the app, when it claimed that kind of drop with `app.onDrop` (announced
 * as `yaar:drop-accept`); otherwise the agent, as a `<ui:*>` gesture message. The claim is
 * read, not asked for — the desktop already holds it when the drop lands, so there is no
 * round trip into the iframe and no timeout choosing between the two.
 *
 * An app that claims files receives the `File`s themselves, not uploaded storage paths: an
 * app taking a drop is about to read the bytes, and uploading them first only for the app
 * to fetch them back would cost a round trip per file for nothing. Only the agent path
 * uploads, because an agent cannot read a `File`.
 */
import { APP_MSG } from '@yaar/shared';
import { filterImageFiles, uploadFiles, uploadImages } from '@/lib/uploadImage';
import { getDesktopState } from './store-access';
import { findIframeIn, findWindowElement, postToIframe } from './target';

/** The kinds of drop an app can take over with `app.onDrop`. */
export type WindowDropKind = 'files' | 'text';

/**
 * Window id → the drop kinds its app claimed. Keyed by the rendered id the claiming iframe
 * was found under, which is also the id `useWindowDrop` holds.
 */
const dropClaims = new Map<string, ReadonlySet<WindowDropKind>>();

/**
 * Record what a window's app claims. `kinds` crosses a postMessage boundary from app code,
 * so anything but a known kind is ignored. An empty claim — which every frame restates when
 * its protocol script installs — forgets the window.
 */
export function setWindowDropClaims(windowId: string, kinds: unknown): void {
  const claimed = new Set<WindowDropKind>();
  if (Array.isArray(kinds)) {
    for (const k of kinds) if (k === 'files' || k === 'text') claimed.add(k);
  }
  if (claimed.size) dropClaims.set(windowId, claimed);
  else dropClaims.delete(windowId);
}

/** Forget a window's claim, for a window that is closing. */
export function forgetWindowDropClaims(windowId: string): void {
  dropClaims.delete(windowId);
}

/**
 * The iframe a `kind` drop goes to, or null when the agent gets it. A claim whose frame is
 * gone is forgotten on the spot: delivering to it would lose the drop.
 */
function claimingFrame(windowId: string, kind: WindowDropKind): HTMLIFrameElement | null {
  if (!dropClaims.get(windowId)?.has(kind)) return null;
  const el = findWindowElement(windowId);
  const iframe = el ? findIframeIn(el) : null;
  if (iframe?.contentWindow) return iframe;
  dropClaims.delete(windowId);
  return null;
}

function describeWindow(windowId: string): string {
  const title = getDesktopState().windows[windowId]?.title ?? windowId;
  return `window "${title}" (id: ${windowId})`;
}

/** OS files dropped onto a window, from its frame or its content. */
export function dropFilesOnWindow(windowId: string, files: File[]): void {
  if (!files.length) return;
  const iframe = claimingFrame(windowId, 'files');
  if (iframe) {
    postToIframe(iframe, { type: APP_MSG.drop, kind: 'files', files });
    return;
  }

  const source = describeWindow(windowId);
  const images = filterImageFiles(files);
  const others = files.filter((f) => !images.includes(f));
  if (images.length) {
    void uploadImages(images).then((paths) => {
      if (!paths.length) return;
      const lines = paths.map((p) => `  image: ${p}`).join('\n');
      getDesktopState().queueGestureMessage(
        `<ui:image_drop>\n${lines}\n  source: ${source}\n</ui:image_drop>`,
      );
    });
  }
  if (others.length) {
    void uploadFiles(others).then((paths) => {
      if (!paths.length) return;
      const lines = paths.map((p) => `  file: ${p}`).join('\n');
      getDesktopState().queueGestureMessage(
        `<ui:file_drop>\n${lines}\n  source: ${source}\n</ui:file_drop>`,
      );
    });
  }
}

/** Text dragged out of one window (its `yaar:drag-start`) and dropped onto another's frame. */
export function dropTextOnWindow(windowId: string, text: string, sourceWindowId: string): void {
  const iframe = claimingFrame(windowId, 'text');
  if (iframe) {
    const title = getDesktopState().windows[sourceWindowId]?.title ?? sourceWindowId;
    postToIframe(iframe, {
      type: APP_MSG.drop,
      kind: 'text',
      text,
      source: { windowId: sourceWindowId, title },
    });
    return;
  }
  getDesktopState().queueGestureMessage(
    `<ui:select>\n  selected_text: "${text.slice(0, 1000)}"\n  source: ${describeWindow(sourceWindowId)}\n</ui:select>\n<ui:drag>\n  target: ${describeWindow(windowId)}\n</ui:drag>`,
  );
}

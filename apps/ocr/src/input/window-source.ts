// OCR from another window: take the OS's own screenshot of it, then read that.
//
// Reading `yaar://windows/{id}` emits a window capture and the verb layer hands the
// image back beside the JSON — so this app never touches the other window's DOM, its
// origin, or its app protocol. It only needs the bytes, which arrive in exactly the
// shape `loadDataUrl` already takes.
import { errMsg, list, read } from '@bundled/yaar';
import { loadDataUrl } from './image-input';
import { setStatus } from '../state';

export interface WindowEntry {
  windowId: string;
  title: string;
  /** Renderer, size, and flags, as the window list reports them. */
  detail: string;
}

interface WindowLink {
  uri: string;
  name: string;
  description?: string;
}

/** Every open window, so a caller with no window id can find one by title. */
export async function listWindows(): Promise<WindowEntry[]> {
  const links = await list<WindowLink[]>('yaar://windows');
  if (!Array.isArray(links)) return [];
  return links.map((link) => ({
    windowId: link.uri.replace(/^yaar:\/\/windows\//, ''),
    title: link.name,
    detail: link.description ?? '',
  }));
}

interface CapturedImage {
  data: string;
  mimeType?: string;
}

interface WindowInfo {
  id?: string;
  title?: string;
  renderer?: string;
  /** Set by the server when a capture was attempted and produced nothing. */
  captureFailure?: string;
  size?: { width: number; height: number };
}

export interface WindowCapture {
  windowId: string;
  title: string;
  renderer: string;
  width: number;
  height: number;
}

/**
 * Say why a window came back without pixels, in terms of what to do next.
 *
 * The three cases need three different responses, and a single "capture failed"
 * would send a caller round the retry loop for two of them: a component or markdown
 * window has no screenshot to give and never will, a tainted canvas is deterministic,
 * and a window that simply has not painted yet is the one worth asking again.
 */
function explainMissingCapture(windowId: string, info: WindowInfo): string {
  const renderer = info.renderer;
  if (renderer && renderer !== 'iframe') {
    return (
      `window "${windowId}" renders ${renderer}, and only iframe (app) windows are ` +
      'captured as an image. Its content is already text — read it with ' +
      `\`read yaar://windows/${windowId}\` instead of OCR-ing a picture of it.`
    );
  }
  if (info.captureFailure === 'taint') {
    return (
      `window "${windowId}" could not be captured: a cross-origin resource tainted its ` +
      'canvas. This is deterministic — retrying will not help.'
    );
  }
  if (info.captureFailure) {
    return `window "${windowId}" could not be captured (${info.captureFailure}).`;
  }
  return (
    `window "${windowId}" returned no image. It may not have painted yet — try again, ` +
    'or check the window id with the `windows` state.'
  );
}

/**
 * Capture a window and make it the loaded image.
 *
 * Leaves the app in exactly the state a dropped screenshot would: `recognize` can
 * follow up on a box from the page read without capturing anything twice.
 */
export async function captureWindow(windowId: string): Promise<WindowCapture> {
  let result: unknown;
  try {
    result = await read<unknown>(`yaar://windows/${windowId}`);
  } catch (e) {
    throw new Error(`could not read window "${windowId}": ${errMsg(e)}`);
  }

  // A window with nothing to capture resolves to the bare metadata rather than the
  // `{ data, images }` wrapper, so both shapes are real answers.
  const wrapped = result as { data?: unknown; images?: CapturedImage[] } | undefined;
  const hasImages = Array.isArray(wrapped?.images);
  const info = ((hasImages ? wrapped?.data : result) ?? {}) as WindowInfo;
  const image = hasImages ? wrapped?.images?.[0] : undefined;
  if (!image?.data) throw new Error(explainMissingCapture(windowId, info));

  const dataUrl = `data:${image.mimeType || 'image/webp'};base64,${image.data}`;
  const size = await loadDataUrl(dataUrl);
  const title = info.title || windowId;
  setStatus(`Captured “${title}” — ${size.w}×${size.h}.`);
  return {
    windowId,
    title,
    renderer: info.renderer ?? 'iframe',
    width: size.w,
    height: size.h,
  };
}

import { createSignal } from '@bundled/solid-js';
import { appStorage } from '@bundled/yaar';
import {
  applyCommand,
  createDoc,
  describeDoc,
  outputSize,
  type Command,
  type Doc,
} from './core/doc';
import { baseImageData, resetLayerCache } from './core/compose';
import { createHistory, push, redo, undo, type History } from './core/history';
import { combineMask, floodSelect, fullMask, type CombineMode, type Mask } from './core/mask';
import { exportBlob, exportDataUrl, type ExportFormat } from './core/render';

export const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|bmp)$/i;

const APP_ID = 'image-edit';

export type StorageFile = { path: string; name: string; url: string };

/**
 * App-scoped files are served from /api/storage/apps/{appId}/… — NOT from
 * `storage.url()`, which resolves against the shared storage root and would
 * 404 for everything this app saves.
 */
function storageFileUrl(path: string): string {
  const clean = path.replace(/^\/+/, '');
  const full = clean.startsWith('apps/') ? clean : `apps/${APP_ID}/${clean}`;
  return `/api/storage/${full.split('/').map(encodeURIComponent).join('/')}`;
}

const [_doc, _setDoc] = createSignal<Doc | null>(null);
export const doc = _doc;

const [_history, _setHistory] = createSignal<History>(createHistory());
export const history = _history;

/** The decoded source bitmap. Not part of Doc — Doc stays serializable. */
const [_image, _setImage] = createSignal<HTMLImageElement | null>(null);
export const image = _image;

export const [status, setStatus] = createSignal('Open an image to start editing.');
/** The saved-image library, refreshed after every save or delete. */
export const [storageFiles, setStorageFiles] = createSignal<StorageFile[]>([]);
/** Bumped on every doc change so the canvas effect re-runs even for in-place edits. */
export const [revision, setRevision] = createSignal(0);

export const canUndo = () => history().past.length > 0;
export const canRedo = () => history().future.length > 0;

/* ---------------------------------------------------------------- tools --- */

export type Tool = 'none' | 'crop' | 'wand' | 'lasso' | 'draw';

/**
 * Tool settings live here rather than in the component so the protocol can read
 * and set them too — an agent asked to "select the background" needs the same
 * tolerance the user sees, not a private copy.
 */
export const [tool, setTool] = createSignal<Tool>('none');
export const [tolerance, setTolerance] = createSignal(32);
export const [contiguous, setContiguous] = createSignal(true);
export const [selectMode, setSelectMode] = createSignal<CombineMode>('replace');
export const [brushSize, setBrushSize] = createSignal(24);
export const [drawColor, setDrawColor] = createSignal('#e5534b');
export const [drawSize, setDrawSize] = createSignal(12);
export const [eraser, setEraser] = createSignal(false);

export const selection = (): Mask | null => doc()?.selection ?? null;
export const hasSelection = (): boolean => (doc()?.selection?.count ?? 0) > 0;

/**
 * A cross-origin image taints the canvas and `getImageData` throws. Translate
 * it — the raw SecurityError says nothing about what the user should do.
 */
function pixelError(e: unknown): Error {
  if (e instanceof DOMException && e.name === 'SecurityError') {
    return new Error(
      'Cannot read pixels: the image came from another origin that did not allow reuse. ' +
        'Save it to storage first, then open it from there.',
    );
  }
  return e instanceof Error ? e : new Error('Could not read image pixels.');
}

/** Source pixels for the wand, or a helpful error. */
export function sourcePixels(): ImageData {
  const d = doc();
  const img = image();
  if (!d || !img) throw new Error('No image is open.');
  try {
    return baseImageData(d, img);
  } catch (e) {
    throw pixelError(e);
  }
}

/**
 * Magic wand at a point in SOURCE coordinates. Combines with the existing
 * selection according to `selectMode`, so shift-style add/subtract and the
 * protocol `mode` parameter go through one path.
 */
export function magicWandAt(
  x: number,
  y: number,
  opts: { tolerance?: number; contiguous?: boolean; mode?: CombineMode } = {},
): Mask | null {
  const d = doc();
  if (!d) throw new Error('No image is open.');

  const tol = opts.tolerance ?? tolerance();
  const contig = opts.contiguous ?? contiguous();
  const mode = opts.mode ?? selectMode();

  const found = floodSelect(sourcePixels(), x, y, tol, contig);
  const merged = combineMask(d.selection, found, mode);
  dispatch({ type: 'setSelection', mask: merged });

  const pct = ((merged.count / (d.base.w * d.base.h)) * 100).toFixed(1);
  setStatus(
    merged.count
      ? `Selected ${merged.count.toLocaleString()} px (${pct}%) · tolerance ${tol} · ${contig ? 'contiguous' : 'global'}`
      : 'Nothing matched — try a higher tolerance.',
  );
  return merged.count ? merged : null;
}

export function selectAll(): void {
  const d = doc();
  if (!d) throw new Error('No image is open.');
  dispatch({ type: 'setSelection', mask: fullMask(d.base.w, d.base.h) });
}

export function clearSelection(): void {
  if (!doc()) return;
  dispatch({ type: 'setSelection', mask: null });
}

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

/** Decode a source into an <img>, resolving once natural dimensions are known. */
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Only cross-origin sources need the opt-in; requesting it for same-origin
    // or data: URLs would fail loads that otherwise work fine.
    if (/^https?:\/\//i.test(src) && !src.startsWith(location.origin)) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image.'));
    img.src = src;
  });
}

/**
 * Replace the document with a new image. Clears history — undo must never walk
 * back into a previous image's edit stack.
 */
export async function openImage(src: string, name: string): Promise<Doc> {
  const img = await loadImageElement(src);
  // Drop the previous image's composited layer and pixel cache before the new
  // doc lands, so a stale bitmap can't be sampled and can be collected.
  resetLayerCache();
  const next = createDoc({
    src,
    name,
    w: img.naturalWidth || img.width,
    h: img.naturalHeight || img.height,
  });
  _setImage(img);
  _setHistory(createHistory());
  _setDoc(next);
  setRevision((n) => n + 1);
  setStatus(`${name} · ${describeDoc(next)}`);
  return next;
}

/** The single mutation point. Every UI handler and protocol command lands here. */
export function dispatch(cmd: Command): Doc {
  const current = doc();
  if (!current) throw new Error('No image is open.');
  const next = applyCommand(current, cmd);
  _setHistory(push(history(), current));
  _setDoc(next);
  setRevision((n) => n + 1);
  setStatus(`${current.base.name} · ${describeDoc(next)}`);
  return next;
}

function restore(result: { history: History; doc: Doc } | null, label: string): Doc | null {
  if (!result) {
    setStatus(`Nothing to ${label}.`);
    return null;
  }
  _setHistory(result.history);
  _setDoc(result.doc);
  setRevision((n) => n + 1);
  setStatus(`${result.doc.base.name} · ${describeDoc(result.doc)} (${label})`);
  return result.doc;
}

export function undoEdit(): Doc | null {
  const current = doc();
  if (!current) return null;
  return restore(undo(history(), current), 'undo');
}

export function redoEdit(): Doc | null {
  const current = doc();
  if (!current) return null;
  return restore(redo(history(), current), 'redo');
}

/** Read a File as a data URL so the doc source survives a reload. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function openLocalFile(file: File): Promise<void> {
  try {
    await openImage(await fileToDataUrl(file), file.name);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : 'Could not open file.');
  }
}

export async function openStoragePath(path: string): Promise<void> {
  try {
    await openImage(storageFileUrl(path), baseName(path));
  } catch (e) {
    setStatus(e instanceof Error ? e.message : 'Could not open storage file.');
  }
}

/** Image files saved in this app's storage. Populates the library panel. */
export async function refreshStorageFiles(): Promise<StorageFile[]> {
  try {
    const entries = await appStorage.list();
    const files = entries
      .filter((e) => !e.isDirectory && IMAGE_EXT_REGEX.test(e.path))
      .map((e) => ({ path: e.path, name: baseName(e.path), url: storageFileUrl(e.path) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setStorageFiles(files);
    return files;
  } catch {
    setStorageFiles([]);
    setStatus('Storage unavailable.');
    return [];
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      // Strip the `data:<mime>;base64,` prefix — the server wants raw base64.
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Ensure the name carries the extension the chosen format actually produces. */
function storageFileName(d: Doc, format: ExportFormat, requested?: string): string {
  const ext = format === 'jpeg' ? 'jpg' : format;
  const stem = (requested ?? `${d.base.name.replace(/\.[^.]+$/, '')}-edited`)
    .replace(/\.[^.]+$/, '')
    .replace(/[/\\]/g, '-')
    .trim();
  return `${stem || 'image'}.${ext}`;
}

/**
 * Render at full resolution and write into app storage as base64 — the one
 * encoding the write endpoint decodes back to bytes.
 */
export async function saveToStorage(
  format: ExportFormat,
  name?: string,
  quality = 0.92,
): Promise<StorageFile> {
  const d = doc();
  const img = image();
  if (!d || !img) throw new Error('No image is open.');

  let blob: Blob | null;
  try {
    blob = await exportBlob(d, img, format, quality);
  } catch (e) {
    throw exportError(e);
  }
  if (!blob) throw new Error('Export produced no data.');

  const fileName = storageFileName(d, format, name);
  await appStorage.save(fileName, await blobToBase64(blob), { encoding: 'base64' });

  const files = await refreshStorageFiles();
  const out = outputSize(d);
  setStatus(`Saved ${fileName} to storage (${out.w}x${out.h}).`);
  return (
    files.find((f) => f.name === fileName) ?? {
      path: fileName,
      name: fileName,
      url: storageFileUrl(fileName),
    }
  );
}

export async function deleteStorageFile(path: string): Promise<void> {
  await appStorage.remove(path);
  await refreshStorageFiles();
  setStatus(`Deleted ${baseName(path)} from storage.`);
}

function exportFileName(d: Doc, format: ExportFormat): string {
  const stem = d.base.name.replace(/\.[^.]+$/, '') || 'image';
  return `${stem}-edited.${format === 'jpeg' ? 'jpg' : format}`;
}

/**
 * A cross-origin source taints the canvas and `toDataURL`/`toBlob` throw a
 * SecurityError. Translate it — the raw message says nothing about what to do.
 */
function exportError(e: unknown): Error {
  if (e instanceof DOMException && e.name === 'SecurityError') {
    return new Error(
      'Cannot export: the image came from another origin that did not allow reuse. ' +
        'Save it to storage first, then open it from there.',
    );
  }
  return e instanceof Error ? e : new Error('Export failed.');
}

/** Trigger a browser download of the full-resolution result. */
export async function downloadExport(format: ExportFormat, quality = 0.92): Promise<string> {
  const d = doc();
  const img = image();
  if (!d || !img) throw new Error('No image is open.');
  let blob: Blob | null;
  try {
    blob = await exportBlob(d, img, format, quality);
  } catch (e) {
    throw exportError(e);
  }
  if (!blob) throw new Error('Export produced no data.');

  const name = exportFileName(d, format);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  const out = outputSize(d);
  setStatus(`Exported ${name} (${out.w}x${out.h}).`);
  return name;
}

/** Full-resolution data URL, for agents that need to hand the result onward. */
export function exportAsDataUrl(format: ExportFormat, quality = 0.92): string {
  const d = doc();
  const img = image();
  if (!d || !img) throw new Error('No image is open.');
  try {
    return exportDataUrl(d, img, format, quality);
  } catch (e) {
    throw exportError(e);
  }
}

/**
 * store.ts — reactive state + the one place doc mutations happen.
 *
 * `mutate(op)` is the funnel: it calls applyOp, pushes the returned inverse on
 * the undo stack, re-syncs the reconciler and sweeps orphaned GPU resources.
 * Phase 2's command stack is already here in embryo (undo/redo below); the
 * gizmo and CSG tools should emit ops through `mutate`, never touch three.
 */
import { createSignal } from '@bundled/solid-js';
import { showToast, errMsg, showConfirm } from '@bundled/yaar';
import {
  applyOp,
  cloneDoc,
  collectBufferRefs,
  countNodes,
  createEmptyDoc,
  findNode,
  ROOT_ID,
  type SceneDoc,
  type SceneNode,
  type SceneOp,
} from './scene-doc';
import { SceneReconciler } from './reconcile';
import { sweep } from './registry';
import type { Viewport } from './viewport';
import { importObject3D } from './import-object';
import { loadModelBuffer, type ResourceResolver } from './loaders';
import {
  MEDIA_DIR,
  baseName,
  dirName,
  fetchUrlBuffer,
  listScenes,
  readSceneJson,
  readStorageBuffer,
  sanitizeFileName,
  saveSceneJson,
  timestamp,
  toStoragePath,
  writeDataUrl,
} from './io';
import { buildDemoDoc } from './demo';

export const HUGE_TRI_WARN = 2_000_000;

export interface Stats {
  nodes: number;
  meshes: number;
  verts: number;
  tris: number;
  fps: number;
}

const [doc, setDocSignal] = createSignal<SceneDoc>(createEmptyDoc());
const [selection, setSelectionSignal] = createSignal<string | null>(null);
const [stats, setStats] = createSignal<Stats>({ nodes: 0, meshes: 0, verts: 0, tris: 0, fps: 0 });
const [busy, setBusy] = createSignal<string | null>(null);
const [warnings, setWarnings] = createSignal<string[]>([]);
const [gridOn, setGridOnSignal] = createSignal(true);
const [wireframeOn, setWireframeSignal] = createSignal(false);
const [sourceLabel, setSourceLabel] = createSignal<string>('');
const [canUndo, setCanUndo] = createSignal(false);
const [canRedo, setCanRedo] = createSignal(false);

export {
  doc,
  selection,
  stats,
  busy,
  warnings,
  gridOn,
  wireframeOn,
  sourceLabel,
  canUndo,
  canRedo,
};

export const reconciler = new SceneReconciler();
let viewport: Viewport | null = null;

const undoStack: SceneOp[] = [];
const redoStack: SceneOp[] = [];
const UNDO_LIMIT = 100;

export function attachViewport(vp: Viewport): void {
  viewport = vp;
  vp.attach(reconciler.root);
  vp.setGridVisible(gridOn());
  vp.onStats = (s) => setStats((prev) => ({ ...prev, fps: s.fps }));
  syncScene();
  if (doc().root.children.length > 0) vp.frameAll();
}

export function getViewport(): Viewport | null {
  return viewport;
}

export function isEmpty(): boolean {
  return doc().root.children.length === 0;
}

/* ------------------------------------------------------------ syncing -- */

function syncScene(): void {
  const current = doc();
  const s = reconciler.sync(current);
  sweep(collectBufferRefs(current));
  reconciler.applyWireframeOverride(wireframeOn() ? true : null, current);
  const counts = countNodes(current);
  setStats((prev) => ({ ...prev, nodes: counts.nodes, meshes: s.meshes, verts: s.verts, tris: s.tris }));
  refreshSelectionHelper();
}

function refreshSelectionHelper(): void {
  if (!viewport) return;
  const id = selection();
  const obj = id ? reconciler.object(id) : undefined;
  viewport.setSelection(obj ?? null);
}

function pushUndo(inverse: SceneOp | null, clearRedo = true): void {
  if (!inverse) return;
  undoStack.push(inverse);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  if (clearRedo) redoStack.length = 0;
  setCanUndo(undoStack.length > 0);
  setCanRedo(redoStack.length > 0);
}

/** THE mutation funnel. Everything that changes the scene goes through here. */
export function mutate(op: SceneOp): boolean {
  const res = applyOp(doc(), op);
  if (!res.changed) return false;
  setDocSignal(res.doc);
  pushUndo(res.inverse);
  syncScene();
  return true;
}

export function undo(): boolean {
  const op = undoStack.pop();
  setCanUndo(undoStack.length > 0);
  if (!op) return false;
  const res = applyOp(doc(), op);
  if (!res.changed) return false;
  setDocSignal(res.doc);
  if (res.inverse) redoStack.push(res.inverse);
  setCanRedo(redoStack.length > 0);
  syncScene();
  return true;
}

export function redo(): boolean {
  const op = redoStack.pop();
  setCanRedo(redoStack.length > 0);
  if (!op) return false;
  const res = applyOp(doc(), op);
  if (!res.changed) return false;
  setDocSignal(res.doc);
  pushUndo(res.inverse, false);
  syncScene();
  return true;
}

/** Replace the whole document (load / clear). Resets history. */
function replaceDoc(next: SceneDoc, label: string): void {
  setDocSignal(next);
  undoStack.length = 0;
  redoStack.length = 0;
  setCanUndo(false);
  setCanRedo(false);
  setSelectionSignal(null);
  setSourceLabel(label);
  syncScene();
}

/* ---------------------------------------------------------- selection -- */

export function select(id: string | null): boolean {
  if (id && !findNode(doc(), id)) return false;
  setSelectionSignal(id);
  refreshSelectionHelper();
  return true;
}

export function selectedNode(): SceneNode | null {
  const id = selection();
  return id ? findNode(doc(), id) : null;
}

/* ------------------------------------------------------------ viewing -- */

export function setGrid(v: boolean): void {
  setGridOnSignal(v);
  viewport?.setGridVisible(v);
}

export function setWireframe(v: boolean): void {
  setWireframeSignal(v);
  reconciler.applyWireframeOverride(v ? true : null, doc());
}

export function frameAll(): boolean {
  return viewport?.frameAll() ?? false;
}

export function frameSelection(): boolean {
  const id = selection();
  const obj = id ? reconciler.object(id) : undefined;
  if (!obj || !viewport) return frameAll();
  return viewport.frameObject(obj);
}

/* ------------------------------------------------------------ loading -- */

function makeResolver(basePath: string, kind: 'storage' | 'url'): ResourceResolver {
  return async (relative: string) => {
    if (!relative || relative.startsWith('data:')) return null;
    try {
      if (kind === 'url') {
        const url = new URL(relative, basePath).toString();
        return await fetchUrlBuffer(url);
      }
      const dir = dirName(basePath);
      return await readStorageBuffer(dir ? `${dir}/${relative}` : relative);
    } catch {
      return null;
    }
  };
}

export interface LoadOutcome {
  name: string;
  format: string;
  meshes: number;
  verts: number;
  tris: number;
  warnings: string[];
}

async function ingest(
  buf: ArrayBuffer,
  name: string,
  resolver: ResourceResolver | undefined,
  label: string,
): Promise<LoadOutcome> {
  // .scene.json round-trips through the doc, not through three
  const asScene = tryParseSceneDoc(buf, name);
  if (asScene) {
    replaceDoc(asScene, label);
    setWarnings([]);
    frameAll();
    const counts = countNodes(asScene);
    const s = reconciler.stats();
    return {
      name,
      format: 'scene',
      meshes: counts.meshes,
      verts: s.verts,
      tris: s.tris,
      warnings: [],
    };
  }

  const result = await loadModelBuffer(buf, { name, resolve: resolver });
  const summary = importObject3D(result.object, baseName(name));

  if (summary.tris > HUGE_TRI_WARN) {
    const ok = await showConfirm(
      `"${name}" has ${summary.tris.toLocaleString()} triangles (over ${(
        HUGE_TRI_WARN / 1e6
      ).toFixed(1)}M). Rendering it may make this window unresponsive. Load anyway?`,
      { title: 'Very large model', okLabel: 'Load anyway', danger: true },
    );
    if (!ok) {
      sweep(collectBufferRefs(doc()));
      throw new Error('Load cancelled — model too large.');
    }
  }

  const next = createEmptyDoc(baseName(name).replace(/\.[^.]+$/, '') || 'Model');
  next.root.children.push(summary.node);
  replaceDoc(next, label);
  setWarnings(result.warnings);
  frameAll();
  select(summary.node.id);

  return {
    name,
    format: result.format,
    meshes: summary.meshes,
    verts: summary.verts,
    tris: summary.tris,
    warnings: result.warnings,
  };
}

function tryParseSceneDoc(buf: ArrayBuffer, name: string): SceneDoc | null {
  if (!name.toLowerCase().endsWith('.json')) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(buf))) as SceneDoc;
    if (parsed && parsed.root && parsed.root.kind === 'group' && Array.isArray(parsed.root.children)) {
      parsed.root.id = ROOT_ID;
      return parsed;
    }
  } catch {
    /* not a scene doc */
  }
  return null;
}

export async function loadFromFile(file: File): Promise<LoadOutcome> {
  setBusy(`Reading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    return await ingest(buf, file.name, undefined, file.name);
  } finally {
    setBusy(null);
  }
}

export async function loadFromStorage(uriOrPath: string): Promise<LoadOutcome> {
  const path = toStoragePath(uriOrPath);
  setBusy(`Loading ${baseName(path)}…`);
  try {
    const buf = await readStorageBuffer(path);
    return await ingest(buf, baseName(path), makeResolver(path, 'storage'), `storage: ${path}`);
  } finally {
    setBusy(null);
  }
}

export async function loadFromUrl(url: string): Promise<LoadOutcome> {
  setBusy(`Fetching ${url}…`);
  try {
    const buf = await fetchUrlBuffer(url);
    return await ingest(buf, baseName(url) || 'model', makeResolver(url, 'url'), url);
  } finally {
    setBusy(null);
  }
}

export function loadSample(): void {
  replaceDoc(buildDemoDoc(), 'demo scene');
  setWarnings([]);
  frameAll();
}

export function clearScene(): void {
  replaceDoc(createEmptyDoc(), '');
  setWarnings([]);
  viewport?.orbit.reset();
}

/* ------------------------------------------------------------- export -- */

export async function renderPNG(path?: string): Promise<string> {
  if (!viewport) throw new Error('Viewport is not ready yet.');
  const dataUrl = viewport.captureDataURL();
  const name = sanitizeFileName(doc().name || 'scene');
  const target = path ? toStoragePath(path) : `${MEDIA_DIR}/${name}-${timestamp()}.png`;
  return await writeDataUrl(target, dataUrl);
}

export async function saveScene(name?: string): Promise<string> {
  const target = name || doc().name || 'scene';
  const json = JSON.stringify(doc(), null, 2);
  const file = await saveSceneJson(target, json);
  if (name && name !== doc().name) mutate({ type: 'setDocName', name });
  return file;
}

export async function listSavedScenes(): Promise<string[]> {
  return await listScenes();
}

export async function openSavedScene(path: string): Promise<void> {
  const text = await readSceneJson(path);
  const parsed = JSON.parse(text) as SceneDoc;
  if (!parsed?.root) throw new Error(`"${path}" is not a 3D Studio scene file.`);
  parsed.root.id = ROOT_ID;
  replaceDoc(parsed, `saved: ${baseName(path)}`);
  setWarnings([]);
  frameAll();
}

export function snapshotDoc(): SceneDoc {
  return cloneDoc(doc());
}

/* ------------------------------------------------------------- errors -- */

export function reportError(e: unknown, context: string): void {
  const msg = errMsg(e);
  console.error(`[studio-3d] ${context}:`, e);
  showToast(msg.length > 180 ? `${msg.slice(0, 177)}…` : msg, 'error', 6000);
}

export function reportInfo(msg: string): void {
  showToast(msg, 'success');
}

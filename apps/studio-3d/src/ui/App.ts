/**
 * App.ts — the IDE shell: toolbar, scene tree, viewport, inspector, status bar.
 */
import html from '@bundled/solid-js/html';
import { Show, createSignal, onCleanup, onMount } from '@bundled/solid-js';
import { showPrompt } from '@bundled/yaar';
import {
  attachViewport,
  busy,
  canRedo,
  canUndo,
  clearScene,
  doc,
  frameAll,
  frameSelection,
  gridOn,
  isEmpty,
  loadFromFile,
  loadSample,
  redo,
  renderPNG,
  reportError,
  reportInfo,
  saveScene,
  setGrid,
  setWireframe,
  sourceLabel,
  stats,
  undo,
  wireframeOn,
} from '../store';
import { Viewport } from '../viewport';
import { SceneTree } from './SceneTree';
import { Inspector } from './Inspector';
import { Dialogs, openScenePicker, openStorageBrowser, openUrlPrompt } from './dialogs';
import { SUPPORTED_EXTENSIONS } from '../loaders';

const [dragging, setDragging] = createSignal(false);

function pickLocalFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = SUPPORTED_EXTENSIONS.join(',');
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void handleFile(file);
  });
  input.click();
}

async function handleFile(file: File): Promise<void> {
  try {
    const out = await loadFromFile(file);
    reportInfo(`Loaded ${out.name} — ${out.meshes} mesh(es), ${out.tris.toLocaleString()} tris`);
  } catch (e) {
    reportError(e, `loading ${file.name}`);
  }
}

async function doSave(): Promise<void> {
  const name = await showPrompt('Save scene as', {
    title: 'Save scene',
    initial: doc().name || 'scene',
    okLabel: 'Save',
  });
  if (!name) return;
  try {
    const path = await saveScene(name);
    reportInfo(`Saved ${path}`);
  } catch (e) {
    reportError(e, 'saving scene');
  }
}

async function doRender(): Promise<void> {
  try {
    const uri = await renderPNG();
    reportInfo(`Rendered to ${uri}`);
  } catch (e) {
    reportError(e, 'rendering PNG');
  }
}

function Toolbar() {
  return html`<div class="tbar">
    <div class="tbar-brand"><span>🧊</span><span>3D Studio</span></div>
    <button class="btn" onClick=${pickLocalFile} title="Open a file from this computer">File…</button>
    <button class="btn" onClick=${openStorageBrowser} title="Browse yaar://storage/">Storage…</button>
    <button class="btn" onClick=${openUrlPrompt} title="Fetch a model over HTTP">URL…</button>
    <button class="btn" onClick=${() => void openScenePicker()} title="Open a saved scene">Scenes…</button>
    <div class="tbar-sep"></div>
    <button class="btn" onClick=${() => void doSave()} title="Save the scene document">Save</button>
    <button class="btn" onClick=${() => void doRender()} title="Render a PNG into media/studio-3d/">
      PNG
    </button>
    <div class="tbar-sep"></div>
    <button class="btn btn-icon" disabled=${() => !canUndo()} onClick=${() => undo()} title="Undo (Ctrl+Z)">
      ↶
    </button>
    <button class="btn btn-icon" disabled=${() => !canRedo()} onClick=${() => redo()} title="Redo (Ctrl+Y)">
      ↷
    </button>
    <button class="btn" onClick=${() => clearScene()} title="Remove everything and free GPU memory">
      Clear
    </button>
    <div class="tbar-spacer"></div>
    <div class="tbar-src">${() => sourceLabel()}</div>
  </div>`;
}

function Hud() {
  return html`<div class="hud">
    <span>tris <b>${() => stats().tris.toLocaleString()}</b></span>
    <span>verts <b>${() => stats().verts.toLocaleString()}</b></span>
    <span>meshes <b>${() => stats().meshes}</b></span>
    <span>fps <b>${() => stats().fps}</b></span>
  </div>`;
}

function HudTools() {
  return html`<div class="hud-tools">
    <button
      class=${() => (gridOn() ? 'btn btn-icon btn-on' : 'btn btn-icon')}
      onClick=${() => setGrid(!gridOn())}
      title="Toggle grid and axes (G)"
    >
      Grid
    </button>
    <button
      class=${() => (wireframeOn() ? 'btn btn-icon btn-on' : 'btn btn-icon')}
      onClick=${() => setWireframe(!wireframeOn())}
      title="Wireframe override (W)"
    >
      Wire
    </button>
    <button class="btn btn-icon" onClick=${() => frameSelection()} title="Frame selection (F)">
      Frame sel
    </button>
    <button class="btn btn-icon" onClick=${() => frameAll()} title="Frame all (A)">Frame all</button>
  </div>`;
}

function EmptyState() {
  return html`<div class="empty">
    <div class="empty-card">
      <div class="empty-icon">🧊</div>
      <div class="empty-title">Nothing loaded</div>
      <div class="empty-text">
        Drop a <b>.glb</b>, <b>.gltf</b>, <b>.obj</b> or <b>.stl</b> anywhere on this window — or
        open one from storage or a URL. Orbit with the left mouse button, pan with right-drag or
        shift-drag, and dolly with the wheel.
      </div>
      <div class="empty-actions">
        <button class="btn btn-primary" onClick=${() => loadSample()}>Load a sample scene</button>
        <button class="btn" onClick=${openStorageBrowser}>Browse storage</button>
        <button class="btn" onClick=${openUrlPrompt}>From URL</button>
      </div>
    </div>
  </div>`;
}

function ViewportPane() {
  let host!: HTMLDivElement;

  onMount(() => {
    const vp = new Viewport(host);
    attachViewport(vp);
    onCleanup(() => vp.dispose());
  });

  return html`<div class="vp">
    <div class="vp-host" ref=${(el: HTMLDivElement) => (host = el)}></div>
    <${Hud} />
    <${HudTools} />
    <div class="vp-hint">LMB orbit · RMB/Shift pan · wheel dolly · F frame selection · A frame all</div>
    <${Show} when=${() => isEmpty()}><${EmptyState} /><//>
    <${Show} when=${() => dragging()}>
      <div class="dropzone">Drop a model to load it</div>
    <//>
  </div>`;
}

function StatusBar() {
  return html`<div class="sbar">
    <span>${() => doc().name}</span>
    <span>nodes ${() => stats().nodes}</span>
    <span>meshes ${() => stats().meshes}</span>
    <span>verts ${() => stats().verts.toLocaleString()}</span>
    <span>tris ${() => stats().tris.toLocaleString()}</span>
    <span class="tbar-spacer"></span>
    <${Show} when=${() => !!busy()}>
      <span class="sbar-busy">${() => busy()}</span>
    <//>
  </div>`;
}

export function App() {
  onMount(() => {
    let depth = 0;
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void handleFile(file);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    onCleanup(() => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    });
  });

  return html`<div class="studio">
    <${Toolbar} />
    <div class="main">
      <${SceneTree} />
      <${ViewportPane} />
      <${Inspector} />
    </div>
    <${StatusBar} />
    <${Dialogs} />
  </div>`;
}

import { createEffect } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import type { EditorStore } from './state';
import { sectionIn } from './anim-utils';
import './styles.css';

export interface EditorUI {
  root: HTMLDivElement;
  modeToggle: HTMLDivElement;
  editTabButton: HTMLButtonElement;
  createTabButton: HTMLButtonElement;
  sidebarEditSection: HTMLDivElement;
  sidebarCreateSection: HTMLDivElement;
  urlInput: HTMLInputElement;
  loadUrlButton: HTMLButtonElement;
  pickFileButton: HTMLButtonElement;
  storagePathInput: HTMLInputElement;
  refreshFilesButton: HTMLButtonElement;
  fileListStatus: HTMLDivElement;
  fileSearch: HTMLInputElement;
  fileList: HTMLDivElement;
  editContainer: HTMLDivElement;
  fileInput: HTMLInputElement;
  video: HTMLVideoElement;
  startRange: HTMLInputElement;
  endRange: HTMLInputElement;
  startInput: HTMLInputElement;
  endInput: HTMLInputElement;
  speedSelect: HTMLSelectElement;
  loopButton: HTMLButtonElement;
  exportButton: HTMLButtonElement;
  exportProgress: HTMLProgressElement;
  exportStatusLabel: HTMLDivElement;
  timeLabel: HTMLDivElement;
  durationLabel: HTMLDivElement;
  shortcutsLabel: HTMLDivElement;
  errorLabel: HTMLDivElement;
  addSceneFromInput: HTMLInputElement;
  addSceneDurInput: HTMLInputElement;
  addSceneSelect: HTMLSelectElement;
  addSceneButton: HTMLButtonElement;
  scenePanel: HTMLDivElement;
  scenePropsPanel: HTMLDivElement;
  compWidthInput: HTMLInputElement;
  compHeightInput: HTMLInputElement;
  compFpsInput: HTMLInputElement;
  compDurationInput: HTMLInputElement;
  createContainer: HTMLDivElement;
  compositionCanvas: HTMLCanvasElement;
  timelineBar: HTMLDivElement;
  timelineTrack: HTMLDivElement;
  creatorPlayButton: HTMLButtonElement;
  creatorExportButton: HTMLButtonElement;
  creatorFrameLabel: HTMLDivElement;
  creatorFrameSlider: HTMLInputElement;
  creatorStatusLabel: HTMLDivElement;
  creatorErrorLabel: HTMLDivElement;
  // Layer management
  addLayerButton: HTMLButtonElement;
  layerListEl: HTMLDivElement;
}

export function createEditorUI(parent: HTMLElement, store: EditorStore): EditorUI {
  parent.innerHTML = '';

  document.documentElement.style.cssText = 'height:100%;overflow:hidden;';
  document.body.style.cssText = 'height:100%;margin:0;overflow:hidden;';
  parent.style.cssText = 'height:100%;overflow:hidden;';

  // ─── Refs ────────────────────────────────────────────────────────────────
  let root!: HTMLDivElement;
  let leftSidebar!: HTMLElement;
  let sidebar!: HTMLElement;
  let modeToggle!: HTMLDivElement;
  let editTabButton!: HTMLButtonElement;
  let createTabButton!: HTMLButtonElement;
  let sidebarEditSection!: HTMLDivElement;
  let sidebarCreateSection!: HTMLDivElement;
  let urlInput!: HTMLInputElement;
  let loadUrlButton!: HTMLButtonElement;
  let pickFileButton!: HTMLButtonElement;
  let storagePathInput!: HTMLInputElement;
  let refreshFilesButton!: HTMLButtonElement;
  let fileListStatus!: HTMLDivElement;
  let fileSearch!: HTMLInputElement;
  let fileList!: HTMLDivElement;
  let editContainer!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  let video!: HTMLVideoElement;
  let startRange!: HTMLInputElement;
  let endRange!: HTMLInputElement;
  let startInput!: HTMLInputElement;
  let endInput!: HTMLInputElement;
  let speedSelect!: HTMLSelectElement;
  let loopButton!: HTMLButtonElement;
  let exportButton!: HTMLButtonElement;
  let exportProgress!: HTMLProgressElement;
  let exportStatusLabel!: HTMLDivElement;
  let timeLabel!: HTMLDivElement;
  let durationLabel!: HTMLDivElement;
  let shortcutsLabel!: HTMLDivElement;
  let errorLabel!: HTMLDivElement;
  let addSceneFromInput!: HTMLInputElement;
  let addSceneDurInput!: HTMLInputElement;
  let addSceneSelect!: HTMLSelectElement;
  let addSceneButton!: HTMLButtonElement;
  let scenePanel!: HTMLDivElement;
  let scenePropsPanel!: HTMLDivElement;
  let compWidthInput!: HTMLInputElement;
  let compHeightInput!: HTMLInputElement;
  let compFpsInput!: HTMLInputElement;
  let compDurationInput!: HTMLInputElement;
  let createContainer!: HTMLDivElement;
  let compositionCanvas!: HTMLCanvasElement;
  let timelineBar!: HTMLDivElement;
  let timelineTrack!: HTMLDivElement;
  let creatorPlayButton!: HTMLButtonElement;
  let creatorExportButton!: HTMLButtonElement;
  let creatorFrameLabel!: HTMLDivElement;
  let creatorFrameSlider!: HTMLInputElement;
  let creatorStatusLabel!: HTMLDivElement;
  let creatorErrorLabel!: HTMLDivElement;
  let addLayerButton!: HTMLButtonElement;
  let layerListEl!: HTMLDivElement;

  // ─── Template ─────────────────────────────────────────────────────────────
  render(() => html`
    <div ref=${(el: HTMLDivElement) => { root = el; }} class="editor-root">
      <div class="sidebar-rail sidebar-rail-left" aria-label="Edit tools">
        <button ref=${(el: HTMLButtonElement) => { editTabButton = el; }}
                type="button" class="sidebar-reveal"
                aria-label="Toggle edit tools" aria-expanded="false" aria-controls="edit-tools">
          <span aria-hidden="true">✂</span><span class="rail-label">Edit</span>
        </button>
      </div>
      <aside ref=${(el: HTMLElement) => { leftSidebar = el; }} id="edit-tools" class="sidebar sidebar-left" aria-label="Edit tools">
        <div ref=${(el: HTMLDivElement) => { modeToggle = el; }} class="drawer-heading">Edit tools</div>
        <div class="sidebar-body">
          <!-- Edit tools -->
          <div ref=${(el: HTMLDivElement) => { sidebarEditSection = el; }}
               style="">
            <div class="y-label sb-title">Source</div>
            <input ref=${(el: HTMLInputElement) => { urlInput = el; }}
                   type="url" class="y-input sb-input"
                   placeholder="https://example.com/video.mp4"
                   style="margin-bottom:6px;" />
            <div class="sb-row">
              <button ref=${(el: HTMLButtonElement) => { loadUrlButton = el; }}
                      type="button" class="y-btn sb-btn" style="flex:1;">Load URL</button>
              <button ref=${(el: HTMLButtonElement) => { pickFileButton = el; }}
                      type="button" class="y-btn sb-btn" style="flex:1;">📁 Local</button>
            </div>

            <hr class="y-divider sb-divider" />
            <div class="y-label sb-title">File Browser</div>
            <div class="sb-row" style="margin-bottom:6px;">
              <input ref=${(el: HTMLInputElement) => { storagePathInput = el; }}
                     type="text" class="y-input sb-input"
                     placeholder="mounts/lecture-materials"
                     value="mounts/lecture-materials"
                     style="flex:1;min-width:0;" />
              <button ref=${(el: HTMLButtonElement) => { refreshFilesButton = el; }}
                      type="button" class="y-btn sb-btn icon" title="Refresh">↺</button>
            </div>
            <input ref=${(el: HTMLInputElement) => { fileSearch = el; }}
                   type="text" class="y-input sb-input"
                   placeholder="🔍  Filter files…"
                   style="margin-bottom:4px;" />
            <div ref=${(el: HTMLDivElement) => { fileListStatus = el; }} class="storage-status"></div>
            <div ref=${(el: HTMLDivElement) => { fileList = el; }} class="storage-list"></div>
            <div class="storage-hint">Click a file to load it directly.</div>
          </div>
        </div>
      </aside>

      <div class="sidebar-rail sidebar-rail-right" aria-label="Create tools">
        <button ref=${(el: HTMLButtonElement) => { createTabButton = el; }}
                type="button" class="sidebar-reveal"
                aria-label="Toggle create tools" aria-expanded="false" aria-controls="create-tools">
          <span aria-hidden="true">✨</span><span class="rail-label">Create</span>
        </button>
      </div>
      <aside ref=${(el: HTMLElement) => { sidebar = el; }} id="create-tools" class="sidebar sidebar-right" aria-label="Create tools">
        <div class="drawer-heading">Create tools</div>
        <div class="sidebar-body">
          <!-- Create tools -->
          <div ref=${(el: HTMLDivElement) => { sidebarCreateSection = el; }}>
            <div class="y-label sb-title">Composition</div>
            <div class="comp-grid">
              <div>
                <label>Width</label>
                <input ref=${(el: HTMLInputElement) => { compWidthInput = el; }}
                       type="number" value="1280" min="100" max="3840" step="1" class="y-input sb-input" />
              </div>
              <div>
                <label>Height</label>
                <input ref=${(el: HTMLInputElement) => { compHeightInput = el; }}
                       type="number" value="720" min="100" max="2160" step="1" class="y-input sb-input" />
              </div>
              <div>
                <label>FPS</label>
                <input ref=${(el: HTMLInputElement) => { compFpsInput = el; }}
                       type="number" value="30" min="1" max="120" step="1" class="y-input sb-input" />
              </div>
              <div>
                <label>Frames</label>
                <input ref=${(el: HTMLInputElement) => { compDurationInput = el; }}
                       type="number" value="150" min="1" step="1" class="y-input sb-input" />
              </div>
            </div>

            <hr class="y-divider sb-divider" />
            <div class="y-label sb-title" style="display:flex;align-items:center;justify-content:space-between;">
              <span>Layers</span>
              <button
                ref=${(el: HTMLButtonElement) => { addLayerButton = el; }}
                type="button" class="y-btn sb-btn icon" title="Add Layer" style="padding:2px 8px;font-size:13px;">＋</button>
            </div>
            <div ref=${(el: HTMLDivElement) => { layerListEl = el; }} class="layer-list"></div>

            <hr class="y-divider sb-divider" />
            <div class="y-label sb-title">Add Scene</div>
            <div class="comp-grid" style="margin-bottom:6px;">
              <div>
                <label>Start Frame</label>
                <input ref=${(el: HTMLInputElement) => { addSceneFromInput = el; }}
                       type="number" value="0" min="0" step="1" class="y-input sb-input" placeholder="0" />
              </div>
              <div>
                <label>Duration</label>
                <input ref=${(el: HTMLInputElement) => { addSceneDurInput = el; }}
                       type="number" min="1" step="1" class="y-input sb-input" placeholder="auto" />
              </div>
            </div>
            <div class="sb-row">
              <select ref=${(el: HTMLSelectElement) => { addSceneSelect = el; }}
                      class="y-input sb-input" style="flex:1;min-width:0;">
                <option value="solid">Solid / Gradient</option>
                <option value="text">Text</option>
                <option value="shape">Shape</option>
                <option value="image">Image</option>
                <option value="video-clip">Video Clip</option>
              </select>
              <button ref=${(el: HTMLButtonElement) => { addSceneButton = el; }}
                      type="button" class="y-btn sb-btn">+ Add</button>
            </div>

            <hr class="y-divider sb-divider" />
            <div class="y-label sb-title">Scenes</div>
            <div ref=${(el: HTMLDivElement) => { scenePanel = el; }} class="scene-list"></div>
            <div ref=${(el: HTMLDivElement) => { scenePropsPanel = el; }} class="scene-props-panel"></div>
          </div>

        </div>
      </aside>

      <!-- ═══ MAIN CONTENT ═══ -->
      <main class="editor-main">
        <header class="editor-topbar">
          <div>
            <p class="eyebrow">Video Editor Lite</p>
            <h1>Make a clean cut.</h1>
          </div>
          <div class="topbar-hint"><b>Edit</b> tools live on the left; <b>Create</b> tools live on the right.</div>
        </header>

        <!-- Hidden file input -->
        <input ref=${(el: HTMLInputElement) => { fileInput = el; }}
               type="file" accept="video/*" style="display:none;" />

        <!-- Edit mode main -->
        <div ref=${(el: HTMLDivElement) => { editContainer = el; }}
             style="">
          <section class="panel">
            <div class="video-wrap">
              <video ref=${(el: HTMLVideoElement) => { video = el; }}
                     controls preload="metadata"
                     style=""></video>
            </div>
          </section>

          <section class="panel">
            <div class="panel-title">Trim &amp; Export</div>
            <div class="trim-grid">
              <div>
                <label>Start (sec)</label>
                <input ref=${(el: HTMLInputElement) => { startInput = el; }}
                       type="number" min="0" step="0.01" value="0" />
                <input ref=${(el: HTMLInputElement) => { startRange = el; }}
                       type="range" min="0" max="0" step="0.01" value="0" />
              </div>
              <div>
                <label>End (sec)</label>
                <input ref=${(el: HTMLInputElement) => { endInput = el; }}
                       type="number" min="0" step="0.01" value="0" />
                <input ref=${(el: HTMLInputElement) => { endRange = el; }}
                       type="range" min="0" max="0" step="0.01" value="0" />
              </div>
            </div>
            <div class="action-row">
              <div>
                <span class="field-label">Speed</span>
                <select ref=${(el: HTMLSelectElement) => { speedSelect = el; }}>
                  <option value="0.5">0.5×</option>
                  <option value="1" selected>1×</option>
                  <option value="1.5">1.5×</option>
                  <option value="2">2×</option>
                </select>
              </div>
              <button ref=${(el: HTMLButtonElement) => { loopButton = el; }}
                      type="button" class="y-btn sb-btn" disabled>▶ Play Trimmed</button>
              <button ref=${(el: HTMLButtonElement) => { exportButton = el; }}
                      type="button" class="y-btn sb-btn" disabled>⬇ Export</button>
            </div>
            <div class="stats-row">
              <span ref=${(el: any) => { timeLabel = el; }} class="chip">Current: 00:00.00</span>
              <span ref=${(el: any) => { durationLabel = el; }} class="chip">Selected: 00:00.00</span>
            </div>
            <progress ref=${(el: HTMLProgressElement) => { exportProgress = el; }}
                      max="1" value="0" hidden></progress>
            <div ref=${(el: HTMLDivElement) => { exportStatusLabel = el; }} class="status-text"></div>
            <div ref=${(el: HTMLDivElement) => { shortcutsLabel = el; }} class="shortcuts-text">
              Shortcuts: Space play/pause · I set start · O set end · X reset · ←/→ ±0.04s · Shift+←/→ ±1s
            </div>
            <div ref=${(el: HTMLDivElement) => { errorLabel = el; }} class="error-text"></div>
          </section>
        </div>

        <!-- Create mode main -->
        <div ref=${(el: HTMLDivElement) => { createContainer = el; }}
             style="display:none">
          <section class="panel">
            <div class="canvas-wrap">
              <canvas ref=${(el: HTMLCanvasElement) => { compositionCanvas = el; }}
                      width="1280" height="720"></canvas>
            </div>
          </section>

          <section class="panel">
            <div class="panel-title">Playback</div>
            <div class="action-row">
              <button ref=${(el: HTMLButtonElement) => { creatorPlayButton = el; }}
                      type="button" class="y-btn sb-btn" style="min-width:90px;">▶ Play</button>
              <button ref=${(el: HTMLButtonElement) => { creatorExportButton = el; }}
                      type="button" class="y-btn sb-btn" style="min-width:130px;">⬇ Export WebM</button>
              <div class="grow">
                <span class="field-label">Frame</span>
                <input ref=${(el: HTMLInputElement) => { creatorFrameSlider = el; }}
                       type="range" min="0" max="149" step="1" value="0" />
              </div>
              <div ref=${(el: HTMLDivElement) => { creatorFrameLabel = el; }}
                   class="chip" style="min-width:110px;text-align:center;">Frame: 0 / 150</div>
            </div>
            <div ref=${(el: HTMLDivElement) => { creatorStatusLabel = el; }} class="status-text"></div>
            <div ref=${(el: HTMLDivElement) => { creatorErrorLabel = el; }} class="error-text"></div>
          </section>

          <section ref=${(el: HTMLDivElement) => { timelineBar = el; }} class="panel timeline-bar">
            <div class="panel-title">Timeline</div>
            <div ref=${(el: HTMLDivElement) => { timelineTrack = el; }} class="timeline-track"></div>
          </section>
        </div>

      </main>
    </div>
  `, parent as HTMLElement);

  // Both edge rails preview on hover; a click pins the relevant drawer for touch, and focus keeps it reachable by keyboard.
  const setDrawerPinned = (side: 'left' | 'right', pinned: boolean) => {
    const button = side === 'left' ? editTabButton : createTabButton;
    const otherSide = side === 'left' ? 'right' : 'left';
    const otherButton = side === 'left' ? createTabButton : editTabButton;
    root.classList.toggle(`${side}-sidebar-pinned`, pinned);
    button.setAttribute('aria-expanded', String(pinned));
    if (pinned) {
      root.classList.remove(`${otherSide}-sidebar-pinned`, `${otherSide}-sidebar-keyboard-open`);
      otherButton.setAttribute('aria-expanded', 'false');
    }
  };
  editTabButton.addEventListener('click', () =>
    setDrawerPinned('left', !root.classList.contains('left-sidebar-pinned')),
  );
  createTabButton.addEventListener('click', () =>
    setDrawerPinned('right', !root.classList.contains('right-sidebar-pinned')),
  );
  editTabButton.addEventListener('focus', () => root.classList.add('left-sidebar-keyboard-open'));
  createTabButton.addEventListener('focus', () => root.classList.add('right-sidebar-keyboard-open'));
  root.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (!root.contains(document.activeElement)) {
        root.classList.remove('left-sidebar-keyboard-open', 'right-sidebar-keyboard-open');
      }
    }, 0);
  });
  const closeDrawerOnEscape = (event: KeyboardEvent, side: 'left' | 'right') => {
    if (event.key !== 'Escape') return;
    setDrawerPinned(side, false);
    root.classList.remove(`${side}-sidebar-keyboard-open`);
    (side === 'left' ? editTabButton : createTabButton).focus();
  };
  leftSidebar.addEventListener('keydown', (event) => closeDrawerOnEscape(event, 'left'));
  sidebar.addEventListener('keydown', (event) => closeDrawerOnEscape(event, 'right'));

  // Reactive mode switching — more reliable than attribute bindings on style/class
  let _prevMode: string | null = null;
  createEffect(() => {
    const isEdit = store.mode[0]() === 'edit';
    const modeStr = isEdit ? 'edit' : 'create';
    const switching = _prevMode !== null && _prevMode !== modeStr;

    editTabButton.classList.toggle('active', isEdit);
    createTabButton.classList.toggle('active', !isEdit);

    if (isEdit) {
      createContainer.style.display = 'none';
      editContainer.style.display = '';
      if (switching) sectionIn(editContainer);
    } else {
      editContainer.style.display = 'none';
      createContainer.style.display = '';
      if (switching) sectionIn(createContainer);
    }
    _prevMode = modeStr;
  });

  return {
    root, modeToggle, editTabButton, createTabButton,
    sidebarEditSection, sidebarCreateSection,
    urlInput, loadUrlButton, pickFileButton,
    storagePathInput, refreshFilesButton,
    fileListStatus, fileSearch, fileList,
    editContainer, fileInput, video,
    startRange, endRange, startInput, endInput,
    speedSelect, loopButton, exportButton,
    exportProgress, exportStatusLabel,
    timeLabel, durationLabel, shortcutsLabel, errorLabel,
    addSceneFromInput, addSceneDurInput, addSceneSelect, addSceneButton, scenePanel, scenePropsPanel,
    compWidthInput, compHeightInput, compFpsInput, compDurationInput,
    createContainer, compositionCanvas,
    timelineBar, timelineTrack,
    creatorPlayButton, creatorExportButton,
    creatorFrameLabel, creatorFrameSlider,
    creatorStatusLabel, creatorErrorLabel,
    addLayerButton, layerListEl,
  };
}

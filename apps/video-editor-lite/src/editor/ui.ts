import type { EditorState } from './types';
import { formatTime } from './utils/time';

export interface EditorUI {
  root: HTMLDivElement;
  // Sidebar mode toggle
  modeToggle: HTMLDivElement;
  editTabButton: HTMLButtonElement;
  createTabButton: HTMLButtonElement;
  // Sidebar sections (toggled by mode)
  sidebarEditSection: HTMLDivElement;
  sidebarCreateSection: HTMLDivElement;
  // Edit mode - sidebar
  urlInput: HTMLInputElement;
  loadUrlButton: HTMLButtonElement;
  pickFileButton: HTMLButtonElement;
  storagePathInput: HTMLInputElement;
  refreshFilesButton: HTMLButtonElement;
  fileListStatus: HTMLDivElement;
  fileSearch: HTMLInputElement;
  fileList: HTMLDivElement;
  // Edit mode - main
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
  // Create mode - sidebar
  addSceneSelect: HTMLSelectElement;
  addSceneButton: HTMLButtonElement;
  scenePanel: HTMLDivElement;
  compWidthInput: HTMLInputElement;
  compHeightInput: HTMLInputElement;
  compFpsInput: HTMLInputElement;
  compDurationInput: HTMLInputElement;
  // Create mode - main
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
}

export function createEditorUI(parent: HTMLElement): EditorUI {
  parent.innerHTML = '';

  const style = document.createElement('style');
  style.textContent = `
    html, body {
      height: 100%;
      margin: 0;
      overflow: hidden;
      font-family: "Segoe UI", Tahoma, sans-serif;
      color: #1f2c3b;
      color-scheme: light;
      background: #e4eff3;
    }
    * { box-sizing: border-box; }

    /* ── Root layout ── */
    .editor-root {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    /* ── Sidebar ── */
    .sidebar {
      width: 260px;
      flex-shrink: 0;
      background: #f1f7fa;
      border-right: 1.5px solid #c2d3db;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-mode-toggle {
      display: flex;
      flex-shrink: 0;
      border-bottom: 1.5px solid #c2d3db;
    }

    .sidebar-mode-toggle button {
      flex: 1;
      padding: 13px 8px;
      border: none;
      border-radius: 0;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      background: #e6f0f5;
      color: #4d6879;
      transition: background 0.15s, color 0.15s;
    }

    .sidebar-mode-toggle button.active {
      background: #235f7c;
      color: #fff;
    }

    .sidebar-mode-toggle button:hover:not(.active) {
      background: #d8e9f1;
    }

    .sidebar-body {
      flex: 1;
      overflow-y: auto;
      padding: 12px 10px 16px;
    }

    .sb-title {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #5a7688;
      margin: 12px 0 5px;
    }

    .sb-title:first-child { margin-top: 0; }

    .sb-divider {
      border: none;
      border-top: 1px solid #cddae2;
      margin: 10px 0;
    }

    /* Sidebar inputs */
    .sb-input {
      width: 100%;
      padding: 7px 9px;
      border: 1px solid #b3c7d1;
      border-radius: 7px;
      font-size: 12px;
      background: #fff;
      color: #13222d;
      outline: none;
    }

    .sb-input:focus {
      border-color: #5599b8;
      box-shadow: 0 0 0 2px rgba(85,153,184,0.18);
    }

    .sb-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .sb-btn {
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid #b3c7d1;
      border-radius: 7px;
      background: #e4eef3;
      color: #2b4a5e;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.12s;
    }

    .sb-btn:hover { background: #d0e4ed; }
    .sb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sb-btn.icon { padding: 7px 11px; font-size: 15px; }

    /* File browser */
    .storage-status {
      font-size: 11px;
      color: #5a7688;
      min-height: 15px;
      margin: 5px 0 3px;
    }

    .storage-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-top: 4px;
    }

    .storage-item {
      display: flex;
      flex-direction: column;
      padding: 7px 9px;
      border-radius: 7px;
      border: 1px solid transparent;
      background: transparent;
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: background 0.1s, border-color 0.1s;
    }

    .storage-item:hover {
      background: #dcedf5;
      border-color: #adcada;
    }

    .storage-item.active {
      background: #c8e2ef;
      border-color: #72b2ce;
    }

    .file-name {
      font-size: 12px;
      font-weight: 600;
      color: #1a3a4e;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-dir {
      font-size: 10px;
      color: #7a98a8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
    }

    .storage-empty {
      font-size: 12px;
      color: #6a8494;
      padding: 10px 4px;
      text-align: center;
    }

    .storage-hint {
      font-size: 10px;
      color: #7a9aaa;
      margin-top: 6px;
    }

    /* Composition settings grid */
    .comp-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    .comp-grid label {
      font-size: 10px;
      font-weight: 700;
      color: #5a7688;
      display: block;
      margin-bottom: 2px;
    }

    .comp-grid .sb-input { padding: 5px 7px; }

    /* Scene list in sidebar */
    .scene-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .scene-item {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 8px;
      border-radius: 7px;
      font-size: 12px;
      cursor: pointer;
      border: 1px solid transparent;
      background: rgba(255,255,255,0.7);
    }

    .scene-item:hover { background: #edf4f7; }

    .scene-item.selected {
      background: #d8eaf3;
      border-color: #9abfd3;
    }

    .scene-item .scene-color {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .scene-item .scene-info { flex: 1; min-width: 0; }

    .scene-item .scene-name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .scene-item .scene-range {
      font-size: 10px;
      color: #5e7381;
      margin-top: 1px;
    }

    .scene-item .scene-delete {
      padding: 2px 7px;
      font-size: 11px;
      border-radius: 4px;
      flex-shrink: 0;
      background: transparent;
      border: 1px solid #c8d5dc;
      cursor: pointer;
    }

    .scene-item .scene-delete:hover {
      background: #fde0e0;
      border-color: #f08888;
    }

    /* ── Main content ── */
    .editor-main {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-width: 0;
    }

    .panel {
      background: rgba(255,255,255,0.94);
      border-radius: 12px;
      border: 1px solid #c5d5de;
      padding: 14px;
    }

    .panel-title {
      font-size: 13px;
      font-weight: 700;
      color: #2b4859;
      margin-bottom: 11px;
    }

    /* Video */
    .video-wrap {
      border-radius: 10px;
      overflow: hidden;
      background: #0d1014;
      min-height: 180px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    video {
      width: 100%;
      max-height: 400px;
      background: #111;
      display: block;
    }

    /* Trim controls */
    .trim-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .trim-grid label, .field-label {
      font-size: 12px;
      font-weight: 600;
      color: #334f63;
      display: block;
      margin-bottom: 3px;
    }

    input[type=number], select {
      width: 100%;
      padding: 7px 9px;
      border: 1px solid #b3c7d1;
      border-radius: 7px;
      font-size: 13px;
      background: #fff;
      color: #13222d;
      outline: none;
    }

    input[type=number]:focus, select:focus {
      border-color: #5599b8;
    }

    input[type=range] {
      width: 100%;
      margin-top: 5px;
      accent-color: #2a6282;
    }

    .action-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    .action-row button, .action-row select {
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 600;
      border: 1px solid #b3c7d1;
      border-radius: 7px;
      background: #e4eef3;
      color: #1e3a4d;
      cursor: pointer;
      transition: background 0.12s;
      width: auto;
    }

    .action-row button:hover { background: #d0e4ed; }
    .action-row button:disabled { opacity: 0.5; cursor: not-allowed; }

    .action-row .grow { flex: 1; min-width: 140px; }

    .stats-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    .chip {
      padding: 6px 12px;
      border-radius: 999px;
      background: #edf5f9;
      border: 1px solid #c2d5de;
      font-size: 13px;
      font-weight: 600;
    }

    .status-text {
      font-size: 12px;
      color: #2b4f67;
      min-height: 16px;
      margin-top: 6px;
    }

    .shortcuts-text {
      font-size: 11px;
      color: #5a7688;
      margin-top: 8px;
      line-height: 1.5;
    }

    .error-text {
      color: #9a1f1f;
      font-size: 13px;
      min-height: 16px;
      margin-top: 4px;
    }

    progress {
      width: 100%;
      height: 8px;
      border-radius: 4px;
      border: none;
      margin-top: 6px;
      accent-color: #2a6282;
    }

    /* Canvas */
    .canvas-wrap {
      border-radius: 10px;
      overflow: hidden;
      background: #0d1014;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .canvas-wrap canvas {
      width: 100%;
      max-height: 380px;
      background: #111;
    }

    /* Timeline */
    .timeline-track {
      position: relative;
      height: 40px;
      background: #1a2733;
      border-radius: 6px;
      overflow: hidden;
    }

    .timeline-block {
      position: absolute;
      top: 2px; bottom: 2px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      color: #fff;
      display: flex;
      align-items: center;
      padding: 0 6px;
      cursor: pointer;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      min-width: 4px;
      border: 1px solid rgba(255,255,255,0.2);
    }

    .timeline-block.selected { border: 2px solid #fff; }

    .timeline-playhead {
      position: absolute;
      top: 0; bottom: 0;
      width: 2px;
      background: #ff4444;
      pointer-events: none;
      z-index: 10;
    }

    @media (max-width: 580px) {
      .sidebar { width: 200px; }
      .trim-grid { grid-template-columns: 1fr; }
      .comp-grid { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);

  // Apply full-height to ancestors
  document.documentElement.style.cssText = 'height:100%;overflow:hidden;';
  document.body.style.cssText = 'height:100%;margin:0;overflow:hidden;';
  parent.style.cssText = 'height:100%;overflow:hidden;';

  const root = document.createElement('div');
  root.className = 'editor-root';

  /* ═══════════════ SIDEBAR ═══════════════ */
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';

  // Mode toggle (top of sidebar)
  const modeToggle = document.createElement('div');
  modeToggle.className = 'sidebar-mode-toggle';
  modeToggle.innerHTML = `
    <button id="edit-tab" class="active" type="button">✂ Edit</button>
    <button id="create-tab" type="button">✨ Create</button>
  `;

  // Sidebar body (scrollable)
  const sidebarBody = document.createElement('div');
  sidebarBody.className = 'sidebar-body';

  /* ── Edit mode sidebar section ── */
  const sidebarEditSection = document.createElement('div');
  sidebarEditSection.innerHTML = `
    <div class="sb-title">Source</div>
    <input id="video-url" type="url" class="sb-input" placeholder="https://example.com/video.mp4" style="margin-bottom:6px;" />
    <div class="sb-row">
      <button id="load-url" type="button" class="sb-btn" style="flex:1;">Load URL</button>
      <button id="pick-file" type="button" class="sb-btn" style="flex:1;">📁 Local</button>
    </div>

    <hr class="sb-divider" />
    <div class="sb-title">File Browser</div>
    <div class="sb-row" style="margin-bottom:6px;">
      <input id="storage-path" type="text" class="sb-input" placeholder="mounts/lecture-materials" value="mounts/lecture-materials" style="flex:1;min-width:0;" />
      <button id="refresh-files" type="button" class="sb-btn icon" title="Refresh">↺</button>
    </div>
    <input id="file-search" type="text" class="sb-input" placeholder="🔍  Filter files…" style="margin-bottom:4px;" />
    <div id="storage-status" class="storage-status"></div>
    <div id="storage-list" class="storage-list"></div>
    <div class="storage-hint">Click a file to load it directly.</div>
  `;

  /* ── Create mode sidebar section ── */
  const sidebarCreateSection = document.createElement('div');
  sidebarCreateSection.style.display = 'none';
  sidebarCreateSection.innerHTML = `
    <div class="sb-title">Composition</div>
    <div class="comp-grid">
      <div>
        <label>Width</label>
        <input id="comp-width" type="number" value="1280" min="100" max="3840" step="1" class="sb-input" />
      </div>
      <div>
        <label>Height</label>
        <input id="comp-height" type="number" value="720" min="100" max="2160" step="1" class="sb-input" />
      </div>
      <div>
        <label>FPS</label>
        <input id="comp-fps" type="number" value="30" min="1" max="120" step="1" class="sb-input" />
      </div>
      <div>
        <label>Frames</label>
        <input id="comp-duration" type="number" value="150" min="1" step="1" class="sb-input" />
      </div>
    </div>

    <hr class="sb-divider" />
    <div class="sb-title">Add Scene</div>
    <div class="sb-row">
      <select id="add-scene-type" class="sb-input" style="flex:1;min-width:0;">
        <option value="solid">Solid / Gradient</option>
        <option value="text">Text</option>
        <option value="shape">Shape</option>
        <option value="image">Image</option>
        <option value="video-clip">Video Clip</option>
      </select>
      <button id="add-scene-btn" type="button" class="sb-btn">+ Add</button>
    </div>

    <hr class="sb-divider" />
    <div class="sb-title">Scenes</div>
    <div id="scene-panel" class="scene-list"></div>
  `;

  sidebarBody.append(sidebarEditSection, sidebarCreateSection);
  sidebar.append(modeToggle, sidebarBody);

  /* ═══════════════ MAIN CONTENT ═══════════════ */
  const mainContent = document.createElement('main');
  mainContent.className = 'editor-main';

  // Hidden file input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*';
  fileInput.style.display = 'none';
  mainContent.appendChild(fileInput);

  /* ── Edit mode main ── */
  const editContainer = document.createElement('div');
  editContainer.id = 'edit-main';

  const previewPanel = document.createElement('section');
  previewPanel.className = 'panel';
  previewPanel.innerHTML = `
    <div class="video-wrap">
      <video id="preview" controls preload="metadata"></video>
    </div>
  `;

  const trimPanel = document.createElement('section');
  trimPanel.className = 'panel';
  trimPanel.innerHTML = `
    <div class="panel-title">Trim &amp; Export</div>
    <div class="trim-grid">
      <div>
        <label>Start (sec)</label>
        <input id="start-input" type="number" min="0" step="0.01" value="0" />
        <input id="start-range" type="range" min="0" max="0" step="0.01" value="0" />
      </div>
      <div>
        <label>End (sec)</label>
        <input id="end-input" type="number" min="0" step="0.01" value="0" />
        <input id="end-range" type="range" min="0" max="0" step="0.01" value="0" />
      </div>
    </div>
    <div class="action-row">
      <div>
        <span class="field-label">Speed</span>
        <select id="speed-select">
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
          <option value="1.5">1.5×</option>
          <option value="2">2×</option>
        </select>
      </div>
      <button id="loop-preview" type="button" disabled>▶ Play Trimmed</button>
      <button id="export-trim" type="button" disabled>⬇ Export</button>
    </div>
    <div class="stats-row">
      <span id="time-label" class="chip">Current: 00:00.00</span>
      <span id="duration-label" class="chip">Selected: 00:00.00</span>
    </div>
    <progress id="export-progress" max="1" value="0" hidden></progress>
    <div id="export-status" class="status-text"></div>
    <div id="shortcuts" class="shortcuts-text">Shortcuts: Space play/pause · I set start · O set end · X reset · ←/→ ±0.04s · Shift+←/→ ±1s</div>
    <div id="error" class="error-text"></div>
  `;

  editContainer.append(previewPanel, trimPanel);

  /* ── Create mode main ── */
  const createContainer = document.createElement('div');
  createContainer.id = 'create-main';
  createContainer.style.display = 'none';

  const canvasPanel = document.createElement('section');
  canvasPanel.className = 'panel';
  canvasPanel.innerHTML = `
    <div class="canvas-wrap">
      <canvas id="creator-canvas" width="1280" height="720"></canvas>
    </div>
  `;

  const controlsPanel = document.createElement('section');
  controlsPanel.className = 'panel';
  controlsPanel.innerHTML = `
    <div class="panel-title">Playback</div>
    <div class="action-row">
      <button id="creator-play" type="button" style="min-width:90px;">▶ Play</button>
      <button id="creator-export" type="button" style="min-width:130px;">⬇ Export WebM</button>
      <div class="grow">
        <span class="field-label">Frame</span>
        <input id="creator-frame-slider" type="range" min="0" max="149" step="1" value="0" />
      </div>
      <div id="creator-frame-label" class="chip" style="min-width:110px;text-align:center;">Frame: 0 / 150</div>
    </div>
    <div id="creator-status" class="status-text"></div>
    <div id="creator-error" class="error-text"></div>
  `;

  const timelinePanel = document.createElement('section');
  timelinePanel.className = 'panel timeline-bar';
  timelinePanel.innerHTML = `
    <div class="panel-title">Timeline</div>
    <div id="timeline-track" class="timeline-track"></div>
  `;

  createContainer.append(canvasPanel, controlsPanel, timelinePanel);
  mainContent.append(editContainer, createContainer);
  root.append(sidebar, mainContent);
  parent.appendChild(root);

  return {
    root,
    modeToggle,
    editTabButton: root.querySelector<HTMLButtonElement>('#edit-tab')!,
    createTabButton: root.querySelector<HTMLButtonElement>('#create-tab')!,
    sidebarEditSection,
    sidebarCreateSection,
    editContainer,
    createContainer,
    urlInput: root.querySelector<HTMLInputElement>('#video-url')!,
    loadUrlButton: root.querySelector<HTMLButtonElement>('#load-url')!,
    pickFileButton: root.querySelector<HTMLButtonElement>('#pick-file')!,
    storagePathInput: root.querySelector<HTMLInputElement>('#storage-path')!,
    refreshFilesButton: root.querySelector<HTMLButtonElement>('#refresh-files')!,
    fileListStatus: root.querySelector<HTMLDivElement>('#storage-status')!,
    fileSearch: root.querySelector<HTMLInputElement>('#file-search')!,
    fileList: root.querySelector<HTMLDivElement>('#storage-list')!,
    fileInput,
    video: root.querySelector<HTMLVideoElement>('#preview')!,
    startRange: root.querySelector<HTMLInputElement>('#start-range')!,
    endRange: root.querySelector<HTMLInputElement>('#end-range')!,
    startInput: root.querySelector<HTMLInputElement>('#start-input')!,
    endInput: root.querySelector<HTMLInputElement>('#end-input')!,
    speedSelect: root.querySelector<HTMLSelectElement>('#speed-select')!,
    loopButton: root.querySelector<HTMLButtonElement>('#loop-preview')!,
    exportButton: root.querySelector<HTMLButtonElement>('#export-trim')!,
    exportProgress: root.querySelector<HTMLProgressElement>('#export-progress')!,
    exportStatusLabel: root.querySelector<HTMLDivElement>('#export-status')!,
    timeLabel: root.querySelector<HTMLDivElement>('#time-label')!,
    durationLabel: root.querySelector<HTMLDivElement>('#duration-label')!,
    shortcutsLabel: root.querySelector<HTMLDivElement>('#shortcuts')!,
    errorLabel: root.querySelector<HTMLDivElement>('#error')!,
    compositionCanvas: root.querySelector<HTMLCanvasElement>('#creator-canvas')!,
    timelineBar: root.querySelector<HTMLDivElement>('.timeline-bar')!,
    timelineTrack: root.querySelector<HTMLDivElement>('#timeline-track')!,
    scenePanel: root.querySelector<HTMLDivElement>('#scene-panel')!,
    addSceneSelect: root.querySelector<HTMLSelectElement>('#add-scene-type')!,
    addSceneButton: root.querySelector<HTMLButtonElement>('#add-scene-btn')!,
    creatorPlayButton: root.querySelector<HTMLButtonElement>('#creator-play')!,
    creatorExportButton: root.querySelector<HTMLButtonElement>('#creator-export')!,
    creatorFrameLabel: root.querySelector<HTMLDivElement>('#creator-frame-label')!,
    creatorFrameSlider: root.querySelector<HTMLInputElement>('#creator-frame-slider')!,
    creatorStatusLabel: root.querySelector<HTMLDivElement>('#creator-status')!,
    creatorErrorLabel: root.querySelector<HTMLDivElement>('#creator-error')!,
    compWidthInput: root.querySelector<HTMLInputElement>('#comp-width')!,
    compHeightInput: root.querySelector<HTMLInputElement>('#comp-height')!,
    compFpsInput: root.querySelector<HTMLInputElement>('#comp-fps')!,
    compDurationInput: root.querySelector<HTMLInputElement>('#comp-duration')!,
  };
}

const SCENE_COLORS: Record<string, string> = {
  solid: '#4a7c59',
  text: '#6a4c93',
  shape: '#c27828',
  image: '#2a7b9b',
  'video-clip': '#8b3a3a',
};

export function renderEditor(ui: EditorUI, state: EditorState): void {
  const isEdit = state.mode === 'edit';

  // Mode toggle active state
  ui.editTabButton.classList.toggle('active', isEdit);
  ui.createTabButton.classList.toggle('active', !isEdit);

  // Show/hide sidebar sections
  ui.sidebarEditSection.style.display = isEdit ? '' : 'none';
  ui.sidebarCreateSection.style.display = isEdit ? 'none' : '';

  // Show/hide main sections
  ui.editContainer.style.display = isEdit ? '' : 'none';
  ui.createContainer.style.display = isEdit ? 'none' : '';

  if (isEdit) {
    const hasDuration = state.duration > 0;
    const selectedDuration = Math.max(0, state.trimEnd - state.trimStart);
    const max = String(state.duration || 0);

    ui.startRange.max = max;
    ui.endRange.max = max;
    ui.startRange.value = String(state.trimStart);
    ui.endRange.value = String(state.trimEnd);
    ui.startInput.value = state.trimStart.toFixed(2);
    ui.endInput.value = state.trimEnd.toFixed(2);
    ui.speedSelect.value = String(state.playbackRate);

    ui.loopButton.disabled = !hasDuration || Boolean(state.error) || state.exporting;
    ui.loopButton.textContent = state.loopPreview ? '⏹ Stop Loop' : '▶ Play Trimmed';

    ui.exportButton.disabled = !hasDuration || Boolean(state.error) || state.exporting;
    ui.exportButton.textContent = state.exporting ? 'Exporting…' : '⬇ Export';
    ui.exportProgress.hidden = !state.exporting;
    ui.exportProgress.value = state.exporting ? Math.min(1, Math.max(0, state.exportProgress)) : 0;
    ui.exportStatusLabel.textContent = state.exportMessage ?? '';

    ui.timeLabel.textContent = `Current: ${formatTime(state.currentTime)}`;
    ui.durationLabel.textContent = hasDuration
      ? `Selected: ${formatTime(selectedDuration)}`
      : 'Selected: 00:00.00';
    ui.errorLabel.textContent = state.error ?? '';

    ui.video.style.opacity = state.sourceValue ? '1' : '0.6';
    return;
  }

  // Create mode
  const comp = state.composition;
  if (!comp) {
    ui.creatorFrameLabel.textContent = 'No composition';
    ui.scenePanel.innerHTML = '<div class="storage-empty">No scenes yet. Add one above.</div>';
    ui.timelineTrack.innerHTML = '';
    return;
  }

  const totalFrames = comp.config.durationInFrames;

  ui.creatorFrameSlider.max = String(Math.max(0, totalFrames - 1));
  ui.creatorFrameSlider.value = String(state.creatorFrame);
  ui.creatorFrameLabel.textContent = `Frame: ${state.creatorFrame} / ${totalFrames}`;

  ui.creatorPlayButton.textContent = state.creatorPlaying ? '⏸ Pause' : '▶ Play';
  ui.creatorExportButton.disabled = state.exporting || state.creatorPlaying;
  ui.creatorExportButton.textContent = state.exporting ? 'Exporting…' : '⬇ Export WebM';
  ui.creatorStatusLabel.textContent = state.exportMessage ?? '';
  ui.creatorErrorLabel.textContent = state.error ?? '';

  if (document.activeElement !== ui.compWidthInput) ui.compWidthInput.value = String(comp.config.width);
  if (document.activeElement !== ui.compHeightInput) ui.compHeightInput.value = String(comp.config.height);
  if (document.activeElement !== ui.compFpsInput) ui.compFpsInput.value = String(comp.config.fps);
  if (document.activeElement !== ui.compDurationInput) ui.compDurationInput.value = String(comp.config.durationInFrames);

  // Timeline
  ui.timelineTrack.innerHTML = '';
  for (const scene of comp.scenes) {
    const block = document.createElement('div');
    block.className = 'timeline-block' + (scene.id === state.selectedSceneId ? ' selected' : '');
    const leftPct = (scene.from / totalFrames) * 100;
    const widthPct = (scene.durationInFrames / totalFrames) * 100;
    block.style.left = `${leftPct}%`;
    block.style.width = `${widthPct}%`;
    block.style.background = SCENE_COLORS[scene.type] ?? '#555';
    block.textContent = scene.type;
    block.dataset.sceneId = scene.id;
    ui.timelineTrack.appendChild(block);
  }

  const playhead = document.createElement('div');
  playhead.className = 'timeline-playhead';
  playhead.style.left = `${(state.creatorFrame / totalFrames) * 100}%`;
  ui.timelineTrack.appendChild(playhead);

  // Scene list
  ui.scenePanel.innerHTML = '';
  if (!comp.scenes.length) {
    ui.scenePanel.innerHTML = '<div class="storage-empty">No scenes yet. Add one above.</div>';
  } else {
    for (const scene of comp.scenes) {
      const item = document.createElement('div');
      item.className = 'scene-item' + (scene.id === state.selectedSceneId ? ' selected' : '');
      item.dataset.sceneId = scene.id;

      const colorDot = document.createElement('div');
      colorDot.className = 'scene-color';
      colorDot.style.background = SCENE_COLORS[scene.type] ?? '#555';

      const info = document.createElement('div');
      info.className = 'scene-info';
      const name = document.createElement('div');
      name.className = 'scene-name';
      name.textContent = `${scene.type} (${scene.id.slice(0, 6)})`;
      const range = document.createElement('div');
      range.className = 'scene-range';
      range.textContent = `Frame ${scene.from} – ${scene.from + scene.durationInFrames}`;
      info.append(name, range);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'scene-delete';
      deleteBtn.textContent = '✕';
      deleteBtn.type = 'button';
      deleteBtn.dataset.deleteSceneId = scene.id;

      item.append(colorDot, info, deleteBtn);
      ui.scenePanel.appendChild(item);
    }
  }
}

import { EDITOR_STYLES } from './styles';

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
  style.textContent = EDITOR_STYLES;
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

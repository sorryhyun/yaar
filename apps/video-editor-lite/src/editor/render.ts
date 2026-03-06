import type { EditorUI } from './ui';
import type { EditorState } from './types';
import type { Scene, Layer } from '../core/types';
import { formatTime } from './utils/time';
import { animate } from '@bundled/anime';
import { fadeIn, staggerIn, fadeOutRemove, popIn } from './anim-utils';

export const SCENE_COLORS: Record<string, string> = {
  solid: '#4a7c59',
  text: '#6a4c93',
  shape: '#c27828',
  image: '#2a7b9b',
  'video-clip': '#8b3a3a',
};

// ── Persistent state for diff-based rendering ──────────────────────────────
let _playheadOverlay: HTMLDivElement | null = null;
let _playheadLine: HTMLDivElement | null = null;
// Map of layerId -> { rowEl, trackEl, blockMap }
let _layerRows = new Map<string, { rowEl: HTMLDivElement; trackEl: HTMLDivElement; blockMap: Map<string, HTMLDivElement> }>();
let _sceneItems = new Map<string, HTMLDivElement>();
let _layerGroupEls = new Map<string, HTMLDivElement>(); // layerId -> group container
let _sceneEmptyEl: HTMLDivElement | null = null;
// ──────────────────────────────────────────────────────────────────────────

export function renderEditor(ui: EditorUI, state: EditorState): void {
  const isEdit = state.mode === 'edit';

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

  // ── Create mode ──────────────────────────────────────────────────────────
  const comp = state.composition;

  if (!comp) {
    ui.creatorFrameLabel.textContent = 'No composition';
    // Clear all persistent state
    for (const { rowEl } of _layerRows.values()) rowEl.remove();
    _layerRows.clear();
    _playheadOverlay = null;
    _playheadLine = null;
    for (const el of _sceneItems.values()) el.remove();
    _sceneItems.clear();
    for (const el of _layerGroupEls.values()) el.remove();
    _layerGroupEls.clear();
    _sceneEmptyEl = null;
    ui.scenePanel.innerHTML = '<div class="storage-empty">No scenes yet. Add one above.</div>';
    ui.timelineTrack.innerHTML = '';
    ui.layerListEl.innerHTML = '';
    return;
  }

  const totalFrames = comp.config.durationInFrames;
  const { layers } = comp;

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

  // ── Layer list in sidebar ────────────────────────────────────────────────
  renderLayerList(ui, layers, state.selectedLayerId);

  // ── Timeline (multi-row, diff-based) ─────────────────────────────────────
  renderTimeline(ui, layers, totalFrames, state.selectedSceneId, state.selectedLayerId, state.creatorFrame);

  // ── Scene list (grouped by layer, diff-based) ────────────────────────────
  renderSceneList(ui, layers, state.selectedSceneId, state.selectedLayerId);

  // ── Scene properties panel ───────────────────────────────────────────────
  const allScenes = layers.flatMap((l) => l.scenes);
  const selectedScene = state.selectedSceneId
    ? allScenes.find((s) => s.id === state.selectedSceneId) ?? null
    : null;
  renderScenePropsPanel(ui.scenePropsPanel, selectedScene);
}

// ── Layer list in sidebar ─────────────────────────────────────────────────
function renderLayerList(ui: EditorUI, layers: Layer[], selectedLayerId: string | null): void {
  const container = ui.layerListEl;
  const currentLayerIds = new Set(layers.map((l) => l.id));

  // Remove deleted layer groups
  for (const [id, el] of [..._layerGroupEls.entries()]) {
    if (!currentLayerIds.has(id)) {
      _layerGroupEls.delete(id);
      animate(el, { opacity: [1, 0], duration: 150 }).then(() => el.remove());
    }
  }

  // Display layers in reverse so top layer (last in array) appears at top of list
  const displayOrder = [...layers].reverse();

  for (const layer of displayOrder) {
    let groupEl = _layerGroupEls.get(layer.id);
    const isNew = !groupEl;

    if (!groupEl) {
      groupEl = document.createElement('div');
      groupEl.className = 'layer-group-item';
      groupEl.dataset.layerId = layer.id;
      _layerGroupEls.set(layer.id, groupEl);
      container.appendChild(groupEl);
      if (isNew) popIn(groupEl);
    }

    const isSelected = layer.id === selectedLayerId;
    groupEl.className = 'layer-group-item' + (isSelected ? ' selected' : '');

    if (isNew) {
      // Build inner content only for new elements
      groupEl.innerHTML = '';
      const visBtn = document.createElement('button');
      visBtn.type = 'button';
      visBtn.className = 'layer-icon-btn';
      visBtn.dataset.layerVis = layer.id;

      const lockBtn = document.createElement('button');
      lockBtn.type = 'button';
      lockBtn.className = 'layer-icon-btn';
      lockBtn.dataset.layerLock = layer.id;

      const nameEl = document.createElement('span');
      nameEl.className = 'layer-name';
      nameEl.dataset.layerSelect = layer.id;
      nameEl.title = layer.name;

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'layer-icon-btn layer-delete';
      deleteBtn.title = 'Delete layer';
      deleteBtn.dataset.layerDelete = layer.id;
      deleteBtn.textContent = '✕';

      groupEl.append(visBtn, lockBtn, nameEl, deleteBtn);
    }

    // Update attributes in-place (for both new and existing)
    const visBtn = groupEl.querySelector<HTMLButtonElement>('[data-layer-vis]')!;
    visBtn.title = layer.visible ? 'Hide layer' : 'Show layer';
    visBtn.textContent = layer.visible ? '👁' : '🙈';

    const lockBtn = groupEl.querySelector<HTMLButtonElement>('[data-layer-lock]')!;
    lockBtn.title = layer.locked ? 'Unlock layer' : 'Lock layer';
    lockBtn.textContent = layer.locked ? '🔒' : '🔓';

    const nameEl = groupEl.querySelector<HTMLSpanElement>('.layer-name')!;
    nameEl.textContent = layer.name;
    nameEl.title = layer.name;
  }

  // Reorder DOM to match displayOrder
  for (const layer of displayOrder) {
    const el = _layerGroupEls.get(layer.id);
    if (el) container.appendChild(el);
  }
}

// ── Timeline multi-row ────────────────────────────────────────────────────
function renderTimeline(
  ui: EditorUI,
  layers: Layer[],
  totalFrames: number,
  selectedSceneId: string | null,
  selectedLayerId: string | null,
  creatorFrame: number,
): void {
  const container = ui.timelineTrack;
  const currentLayerIds = new Set(layers.map((l) => l.id));
  const allSceneIds = new Set(layers.flatMap((l) => l.scenes.map((s) => s.id)));

  // Remove deleted layer rows
  for (const [id, { rowEl }] of [..._layerRows.entries()]) {
    if (!currentLayerIds.has(id)) {
      _layerRows.delete(id);
      animate(rowEl, { opacity: [1, 0], duration: 150 }).then(() => rowEl.remove());
    }
  }

  // Ensure playhead overlay exists (spans all rows)
  if (!_playheadOverlay || !container.contains(_playheadOverlay)) {
    _playheadOverlay = document.createElement('div');
    _playheadOverlay.className = 'tl-playhead-overlay';
    _playheadLine = document.createElement('div');
    _playheadLine.className = 'timeline-playhead';
    _playheadOverlay.appendChild(_playheadLine);
    container.appendChild(_playheadOverlay);
  }

  // Display layers: top layer (last in array) at top of timeline, bottom layer (first) at bottom
  const displayOrder = [...layers].reverse();

  for (const layer of displayOrder) {
    let layerRow = _layerRows.get(layer.id);
    const isNewRow = !layerRow;

    if (!layerRow) {
      const rowEl = document.createElement('div');
      rowEl.className = 'tl-layer-row';
      rowEl.dataset.layerId = layer.id;

      const labelEl = document.createElement('div');
      labelEl.className = 'tl-layer-label';
      labelEl.dataset.layerSelect = layer.id;

      const trackEl = document.createElement('div');
      trackEl.className = 'tl-layer-area';

      rowEl.append(labelEl, trackEl);
      container.insertBefore(rowEl, _playheadOverlay);

      layerRow = { rowEl, trackEl, blockMap: new Map() };
      _layerRows.set(layer.id, layerRow);
    }

    const { rowEl, trackEl, blockMap } = layerRow;

    // Update row styling
    rowEl.classList.toggle('selected', layer.id === selectedLayerId);
    rowEl.classList.toggle('hidden-layer', !layer.visible);

    // Update label
    const labelEl = rowEl.querySelector<HTMLDivElement>('.tl-layer-label')!;
    labelEl.textContent = layer.name;

    // Remove deleted scene blocks in this layer
    for (const [sceneId, blockEl] of [...blockMap.entries()]) {
      if (!allSceneIds.has(sceneId)) {
        blockMap.delete(sceneId);
        animate(blockEl, { opacity: [1, 0], duration: 150 }).then(() => blockEl.remove());
      }
    }

    // Update / create scene blocks
    for (const scene of layer.scenes) {
      let block = blockMap.get(scene.id);
      const isNew = !block;

      if (!block) {
        block = document.createElement('div');
        block.dataset.sceneId = scene.id;
        trackEl.appendChild(block);
        blockMap.set(scene.id, block);
      }

      block.className = 'timeline-block' + (scene.id === selectedSceneId ? ' selected' : '');
      const leftPct = (scene.from / totalFrames) * 100;
      const widthPct = (scene.durationInFrames / totalFrames) * 100;
      block.style.left = `${leftPct}%`;
      block.style.width = `${widthPct}%`;
      block.style.background = SCENE_COLORS[scene.type] ?? '#555';
      block.style.opacity = layer.visible ? '1' : '0.4';
      block.textContent = scene.type;

      if (isNew) popIn(block);
    }
  }

  // Reorder layer rows in DOM (keep playhead overlay at end)
  for (const layer of displayOrder) {
    const row = _layerRows.get(layer.id);
    if (row) container.insertBefore(row.rowEl, _playheadOverlay);
  }

  // Update playhead position
  if (_playheadLine) {
    _playheadLine.style.left = `${(creatorFrame / totalFrames) * 100}%`;
  }
}

// ── Scene list grouped by layer ───────────────────────────────────────────
function renderSceneList(
  ui: EditorUI,
  layers: Layer[],
  selectedSceneId: string | null,
  selectedLayerId: string | null,
): void {
  const container = ui.scenePanel;
  const allCurrentSceneIds = new Set(layers.flatMap((l) => l.scenes.map((s) => s.id)));

  // Remove scene items that no longer exist
  for (const [id, itemEl] of [..._sceneItems.entries()]) {
    if (!allCurrentSceneIds.has(id)) {
      _sceneItems.delete(id);
      fadeOutRemove(itemEl);
    }
  }

  // Check total scene count for empty state
  const totalScenes = layers.reduce((sum, l) => sum + l.scenes.length, 0);

  if (totalScenes === 0) {
    if (!_sceneEmptyEl || !container.contains(_sceneEmptyEl)) {
      _sceneEmptyEl = document.createElement('div');
      _sceneEmptyEl.className = 'storage-empty';
      _sceneEmptyEl.textContent = 'No scenes yet. Add one above.';
      container.appendChild(_sceneEmptyEl);
      fadeIn(_sceneEmptyEl);
    }
  } else {
    if (_sceneEmptyEl && container.contains(_sceneEmptyEl)) {
      _sceneEmptyEl.remove();
      _sceneEmptyEl = null;
    }
  }

  // Group scenes by layer. Display layers in reverse (top layer first in UI)
  const displayOrder = [...layers].reverse();
  const newItems: HTMLElement[] = [];

  for (const layer of displayOrder) {
    // Layer header: use a dedicated element per layer, tracked by layerId
    let layerHeaderKey = `__header_${layer.id}`;
    let headerEl = _sceneItems.get(layerHeaderKey) as HTMLDivElement | undefined;
    if (!headerEl) {
      headerEl = document.createElement('div');
      headerEl.className = 'scene-layer-header';
      headerEl.dataset.layerHeader = layer.id;
      _sceneItems.set(layerHeaderKey, headerEl);
      container.appendChild(headerEl);
    }

    headerEl.className = 'scene-layer-header' + (layer.id === selectedLayerId ? ' active-layer' : '');
    headerEl.innerHTML = '';

    const visSpan = document.createElement('span');
    visSpan.className = 'scene-layer-vis';
    visSpan.textContent = layer.visible ? '👁' : '🙈';
    visSpan.dataset.layerVis = layer.id;

    const lockSpan = document.createElement('span');
    lockSpan.className = 'scene-layer-vis';
    lockSpan.textContent = layer.locked ? '🔒' : '🔓';
    lockSpan.dataset.layerLock = layer.id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'scene-layer-name';
    nameSpan.textContent = layer.name;
    nameSpan.dataset.layerSelect = layer.id;

    const countSpan = document.createElement('span');
    countSpan.className = 'scene-layer-count';
    countSpan.textContent = `${layer.scenes.length} scene${layer.scenes.length !== 1 ? 's' : ''}`;

    headerEl.append(visSpan, lockSpan, nameSpan, countSpan);

    // Scene items within this layer
    for (const scene of layer.scenes) {
      let item = _sceneItems.get(scene.id);
      const isNew = !item;

      if (!item) {
        item = createSceneListItem(scene, layer.locked);
        container.appendChild(item);
        _sceneItems.set(scene.id, item);
        newItems.push(item);
      }

      item.className = 'scene-item' + (scene.id === selectedSceneId ? ' selected' : '') + (layer.locked ? ' locked' : '');
      item.style.opacity = layer.visible ? '1' : '0.5';

      const rangeEl = item.querySelector('.scene-range') as HTMLElement | null;
      if (rangeEl) {
        rangeEl.textContent = `Frame ${scene.from} – ${scene.from + scene.durationInFrames}`;
      }
      const deleteBtn = item.querySelector<HTMLButtonElement>('.scene-delete');
      if (deleteBtn) deleteBtn.disabled = layer.locked;
    }
  }

  // Reorder DOM: headers and scene items in correct layer order
  for (const layer of displayOrder) {
    const headerKey = `__header_${layer.id}`;
    const hEl = _sceneItems.get(headerKey);
    if (hEl) container.appendChild(hEl);
    for (const scene of layer.scenes) {
      const el = _sceneItems.get(scene.id);
      if (el) container.appendChild(el);
    }
  }

  if (newItems.length > 0) staggerIn(newItems);
}

function createSceneListItem(scene: Scene, locked: boolean): HTMLDivElement {
  const item = document.createElement('div');
  item.className = 'scene-item';
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
  deleteBtn.disabled = locked;

  item.append(colorDot, info, deleteBtn);
  return item;
}

function makeField(label: string, inputEl: HTMLElement): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'props-field';
  const lbl = document.createElement('label');
  lbl.className = 'props-label';
  lbl.textContent = label;
  wrapper.append(lbl, inputEl);
  return wrapper;
}

function makeInput(type: string, value: string | number, prop: string, extra?: Partial<HTMLInputElement>): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.value = String(value);
  el.dataset.prop = prop;
  el.className = 'sb-input';
  if (extra) Object.assign(el, extra);
  return el;
}

function makeSelect(options: { value: string; label: string }[], value: string, prop: string): HTMLSelectElement {
  const el = document.createElement('select');
  el.dataset.prop = prop;
  el.className = 'sb-input';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    el.appendChild(o);
  }
  return el;
}

let _lastPropsSceneId: string | null = null;

function updatePropValues(panelEl: HTMLDivElement, scene: Scene): void {
  const props = (scene as any).props ?? {};
  const fromInput = panelEl.querySelector<HTMLInputElement>('[data-prop="from"]');
  if (fromInput && document.activeElement !== fromInput) fromInput.value = String(scene.from);
  const durInput = panelEl.querySelector<HTMLInputElement>('[data-prop="durationInFrames"]');
  if (durInput && document.activeElement !== durInput) durInput.value = String(scene.durationInFrames);
  for (const [key, val] of Object.entries(props)) {
    const input = panelEl.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-prop="${key}"]`);
    if (input && document.activeElement !== input) input.value = String(val);
  }
}

export function renderScenePropsPanel(panelEl: HTMLDivElement, scene: Scene | null): void {
  // In-place update if same scene (preserves focus/cursor)
  if (scene && scene.id === _lastPropsSceneId) {
    updatePropValues(panelEl, scene);
    return;
  }
  _lastPropsSceneId = scene?.id ?? null;

  panelEl.innerHTML = '';

  if (!scene) {
    const hint = document.createElement('div');
    hint.className = 'storage-empty';
    hint.textContent = 'Click a scene to edit its properties.';
    panelEl.appendChild(hint);
    return;
  }

  const title = document.createElement('div');
  title.className = 'sb-title';
  title.style.marginTop = '10px';
  title.textContent = `Properties: ${scene.type}`;
  panelEl.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'props-grid';
  panelEl.appendChild(grid);

  grid.appendChild(makeField('Start Frame', makeInput('number', scene.from, 'from', { min: '0', step: '1' } as Partial<HTMLInputElement>)));
  grid.appendChild(makeField('Duration (frames)', makeInput('number', scene.durationInFrames, 'durationInFrames', { min: '1', step: '1' } as Partial<HTMLInputElement>)));

  const props = (scene as any).props ?? {};

  if (scene.type === 'text') {
    const animOptions = [
      { value: 'none', label: 'None' },
      { value: 'fadeIn', label: 'Fade In' },
      { value: 'fadeOut', label: 'Fade Out' },
      { value: 'fade', label: 'Fade In+Out' },
      { value: 'slideUp', label: 'Slide Up' },
      { value: 'slideDown', label: 'Slide Down' },
      { value: 'typewriter', label: 'Typewriter' },
      { value: 'scale', label: 'Scale' },
      { value: 'spring', label: 'Spring' },
      { value: 'glitch', label: 'Glitch' },
      { value: 'blurIn', label: 'Blur In' },
      { value: 'bounce', label: 'Bounce' },
    ];
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = props.text ?? '';
    textInput.dataset.prop = 'text';
    textInput.className = 'sb-input';
    grid.appendChild(makeField('Text', textInput));
    grid.appendChild(makeField('Font Size', makeInput('number', props.fontSize ?? 48, 'fontSize', { min: '1', step: '1' } as Partial<HTMLInputElement>)));
    grid.appendChild(makeField('Color', makeInput('color', props.color ?? '#ffffff', 'color')));
    grid.appendChild(makeField('Animation', makeSelect(animOptions, props.animation ?? 'none', 'animation')));
    grid.appendChild(makeField('Anim Duration', makeInput('number', props.animationDuration ?? 15, 'animationDuration', { min: '1', step: '1' } as Partial<HTMLInputElement>)));
    grid.appendChild(makeField('X (0-1)', makeInput('number', props.x ?? 0.5, 'x', { min: '0', max: '1', step: '0.01' } as Partial<HTMLInputElement>)));
    grid.appendChild(makeField('Y (0-1)', makeInput('number', props.y ?? 0.5, 'y', { min: '0', max: '1', step: '0.01' } as Partial<HTMLInputElement>)));
  } else if (scene.type === 'solid') {
    grid.appendChild(makeField('Color', makeInput('color', props.color ?? '#000000', 'color')));
    grid.appendChild(makeField('Color End', makeInput('color', props.colorEnd ?? '#000000', 'colorEnd')));
  } else if (scene.type === 'shape') {
    const shapeOptions = [
      { value: 'rect', label: 'Rectangle' },
      { value: 'circle', label: 'Circle' },
      { value: 'roundedRect', label: 'Rounded Rect' },
      { value: 'line', label: 'Line' },
    ];
    grid.appendChild(makeField('Shape', makeSelect(shapeOptions, props.shape ?? 'rect', 'shape')));
    grid.appendChild(makeField('X', makeInput('number', props.x ?? 0, 'x', { step: '1' } as Partial<HTMLInputElement>)));
    grid.appendChild(makeField('Y', makeInput('number', props.y ?? 0, 'y', { step: '1' } as Partial<HTMLInputElement>)));
    grid.appendChild(makeField('Width', makeInput('number', props.width ?? 200, 'width', { min: '1', step: '1' } as Partial<HTMLInputElement>)));
    grid.appendChild(makeField('Height', makeInput('number', props.height ?? 200, 'height', { min: '1', step: '1' } as Partial<HTMLInputElement>)));
    grid.appendChild(makeField('Color', makeInput('color', props.color ?? '#ffffff', 'color')));
  } else if (scene.type === 'image' || scene.type === 'video-clip') {
    const srcInput = document.createElement('input');
    srcInput.type = 'text';
    srcInput.value = props.src ?? '';
    srcInput.dataset.prop = 'src';
    srcInput.className = 'sb-input';
    srcInput.placeholder = 'https://...';
    grid.appendChild(makeField('Source URL', srcInput));
  }
}

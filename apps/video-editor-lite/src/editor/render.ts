import type { EditorUI } from './ui';
import type { EditorState } from './types';
import type { Scene } from '../core/types';
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
let _playhead: HTMLDivElement | null = null;
let _timelineBlocks = new Map<string, HTMLDivElement>();
let _sceneItems = new Map<string, HTMLDivElement>();
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
    // Clear persistent state
    for (const el of _sceneItems.values()) el.remove();
    _sceneItems.clear();
    _sceneEmptyEl = null;
    for (const el of _timelineBlocks.values()) el.remove();
    _timelineBlocks.clear();
    _playhead = null;
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

  // ── Timeline (diff-based) ─────────────────────────────────────────────────
  const currentSceneIds = new Set(comp.scenes.map((s) => s.id));

  // Remove deleted blocks
  for (const [id, blockEl] of [..._timelineBlocks.entries()]) {
    if (!currentSceneIds.has(id)) {
      _timelineBlocks.delete(id);
      animate_opacity_out(blockEl);
    }
  }

  // Ensure playhead exists (create before blocks so it's at back, we'll re-append it at end)
  if (!_playhead || !ui.timelineTrack.contains(_playhead)) {
    _playhead = document.createElement('div');
    _playhead.className = 'timeline-playhead';
    ui.timelineTrack.appendChild(_playhead);
  }

  // Update / create timeline blocks
  for (const scene of comp.scenes) {
    let block = _timelineBlocks.get(scene.id);
    const isNew = !block;

    if (!block) {
      block = document.createElement('div');
      block.dataset.sceneId = scene.id;
      ui.timelineTrack.insertBefore(block, _playhead);
      _timelineBlocks.set(scene.id, block);
    }

    block.className = 'timeline-block' + (scene.id === state.selectedSceneId ? ' selected' : '');
    const leftPct = (scene.from / totalFrames) * 100;
    const widthPct = (scene.durationInFrames / totalFrames) * 100;
    block.style.left = `${leftPct}%`;
    block.style.width = `${widthPct}%`;
    block.style.background = SCENE_COLORS[scene.type] ?? '#555';
    block.textContent = scene.type;

    if (isNew) popIn(block);
  }

  // Move playhead to end so it renders on top
  ui.timelineTrack.appendChild(_playhead);
  _playhead.style.left = `${(state.creatorFrame / totalFrames) * 100}%`;

  // ── Scene list (diff-based) ───────────────────────────────────────────────
  // Remove deleted scenes
  for (const [id, itemEl] of [..._sceneItems.entries()]) {
    if (!currentSceneIds.has(id)) {
      _sceneItems.delete(id);
      fadeOutRemove(itemEl);
    }
  }

  // Empty state
  if (comp.scenes.length === 0) {
    if (!_sceneEmptyEl || !ui.scenePanel.contains(_sceneEmptyEl)) {
      _sceneEmptyEl = document.createElement('div');
      _sceneEmptyEl.className = 'storage-empty';
      _sceneEmptyEl.textContent = 'No scenes yet. Add one above.';
      ui.scenePanel.appendChild(_sceneEmptyEl);
      fadeIn(_sceneEmptyEl);
    }
  } else {
    if (_sceneEmptyEl && ui.scenePanel.contains(_sceneEmptyEl)) {
      _sceneEmptyEl.remove();
      _sceneEmptyEl = null;
    }
  }

  // Add/update scenes
  const newItems: HTMLElement[] = [];
  for (const scene of comp.scenes) {
    let item = _sceneItems.get(scene.id);
    const isNew = !item;

    if (!item) {
      item = createSceneListItem(scene);
      ui.scenePanel.appendChild(item);
      _sceneItems.set(scene.id, item);
      newItems.push(item);
    }

    // Update selected class
    item.className = 'scene-item' + (scene.id === state.selectedSceneId ? ' selected' : '');
    // Update range display
    const rangeEl = item.querySelector('.scene-range') as HTMLElement | null;
    if (rangeEl) {
      rangeEl.textContent = `Frame ${scene.from} – ${scene.from + scene.durationInFrames}`;
    }
  }

  // Reorder DOM to match comp.scenes order
  for (const scene of comp.scenes) {
    const el = _sceneItems.get(scene.id);
    if (el) ui.scenePanel.appendChild(el); // moves existing elements
  }

  if (newItems.length > 0) staggerIn(newItems);

  // ── Scene properties panel ───────────────────────────────────────────────
  const selectedScene = state.selectedSceneId
    ? comp.scenes.find((s) => s.id === state.selectedSceneId) ?? null
    : null;
  renderScenePropsPanel(ui.scenePropsPanel, selectedScene);
}

// Quick opacity-out removal helper (internal, no translate)
function animate_opacity_out(el: HTMLElement): void {
  animate(el, { opacity: [1, 0], duration: 150 }).then(() => el.remove());
}

function createSceneListItem(scene: Scene): HTMLDivElement {
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

export function renderScenePropsPanel(panelEl: HTMLDivElement, scene: Scene | null): void {
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

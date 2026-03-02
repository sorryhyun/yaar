import type { EditorUI } from './ui';
import type { EditorState } from './types';
import { formatTime } from './utils/time';

export const SCENE_COLORS: Record<string, string> = {
  solid: '#4a7c59',
  text: '#6a4c93',
  shape: '#c27828',
  image: '#2a7b9b',
  'video-clip': '#8b3a3a',
};

export function renderEditor(ui: EditorUI, state: EditorState): void {
  const isEdit = state.mode === 'edit';

  // NOTE: mode toggle active classes and section show/hide are now
  // handled reactively by the signal bindings in ui.ts template.

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

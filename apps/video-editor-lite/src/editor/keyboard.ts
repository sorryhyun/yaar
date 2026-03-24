import type { EditorStore } from './state';
import type { EditMode } from './edit-mode';
import type { CreatorMode } from './creator-mode';
import { MIN_TRIM_GAP } from './export-utils';
import { clamp } from './utils/time';
import { onShortcut } from '@bundled/yaar';

export function setupKeyboardShortcuts(
  store: EditorStore,
  editMode: EditMode,
  creatorMode: CreatorMode,
): () => void {
  const cleanups: Array<() => void> = [];

  const reg = (shortcut: string, handler: () => void): void => {
    cleanups.push(onShortcut(shortcut, handler));
  };

  // Space: play/pause (both modes)
  reg('space', () => {
    const { mode } = store.getState();
    if (mode === 'create') {
      creatorMode.handleCreatorPlayPause();
    } else {
      void editMode.togglePlayPause();
    }
  });

  // I: set trim start (edit mode only)
  reg('i', () => {
    const state = store.getState();
    if (state.mode !== 'edit') return;
    if (state.duration <= 0) return;
    const nextStart = Math.min(
      editMode.getCurrentVideoTime(),
      Math.max(0, state.trimEnd - MIN_TRIM_GAP),
    );
    editMode.applyTrimStart(nextStart);
  });

  // O: set trim end (edit mode only)
  reg('o', () => {
    const state = store.getState();
    if (state.mode !== 'edit') return;
    if (state.duration <= 0) return;
    const nextEnd = Math.max(
      editMode.getCurrentVideoTime(),
      state.trimStart + MIN_TRIM_GAP,
    );
    editMode.applyTrimEnd(nextEnd);
  });

  // X: reset trim to full duration (edit mode only)
  reg('x', () => {
    const state = store.getState();
    if (state.mode !== 'edit') return;
    editMode.resetTrimToFullDuration();
  });

  // ArrowLeft (no modifier): seek -0.04s (edit) or -1 frame (create)
  reg('arrowleft', () => {
    const state = store.getState();
    if (state.mode === 'edit') {
      editMode.seekBy(-0.04);
    } else if (state.mode === 'create') {
      const maxFrame = (state.composition?.config.durationInFrames ?? 1) - 1;
      const nextFrame = clamp(state.creatorFrame - 1, 0, maxFrame);
      const player = creatorMode.getPreviewPlayer();
      if (player) {
        player.pause();
        store.setCreatorPlaying(false);
        player.seek(nextFrame);
      }
      store.setCreatorFrame(nextFrame);
    }
  });

  // ArrowRight (no modifier): seek +0.04s (edit) or +1 frame (create)
  reg('arrowright', () => {
    const state = store.getState();
    if (state.mode === 'edit') {
      editMode.seekBy(0.04);
    } else if (state.mode === 'create') {
      const maxFrame = (state.composition?.config.durationInFrames ?? 1) - 1;
      const nextFrame = clamp(state.creatorFrame + 1, 0, maxFrame);
      const player = creatorMode.getPreviewPlayer();
      if (player) {
        player.pause();
        store.setCreatorPlaying(false);
        player.seek(nextFrame);
      }
      store.setCreatorFrame(nextFrame);
    }
  });

  // Shift+ArrowLeft: seek -1s (edit) or -10 frames (create)
  reg('shift+arrowleft', () => {
    const state = store.getState();
    if (state.mode === 'edit') {
      editMode.seekBy(-1);
    } else if (state.mode === 'create') {
      const maxFrame = (state.composition?.config.durationInFrames ?? 1) - 1;
      const nextFrame = clamp(state.creatorFrame - 10, 0, maxFrame);
      const player = creatorMode.getPreviewPlayer();
      if (player) {
        player.pause();
        store.setCreatorPlaying(false);
        player.seek(nextFrame);
      }
      store.setCreatorFrame(nextFrame);
    }
  });

  // Shift+ArrowRight: seek +1s (edit) or +10 frames (create)
  reg('shift+arrowright', () => {
    const state = store.getState();
    if (state.mode === 'edit') {
      editMode.seekBy(1);
    } else if (state.mode === 'create') {
      const maxFrame = (state.composition?.config.durationInFrames ?? 1) - 1;
      const nextFrame = clamp(state.creatorFrame + 10, 0, maxFrame);
      const player = creatorMode.getPreviewPlayer();
      if (player) {
        player.pause();
        store.setCreatorPlaying(false);
        player.seek(nextFrame);
      }
      store.setCreatorFrame(nextFrame);
    }
  });

  return () => cleanups.forEach((fn) => fn());
}

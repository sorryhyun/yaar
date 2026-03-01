import type { EditorStore } from './state';
import type { EditMode } from './edit-mode';
import type { CreatorMode } from './creator-mode';
import { MIN_TRIM_GAP } from './export-utils';
import { clamp } from './utils/time';

function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    Boolean(target.closest('input, textarea, select'))
  );
}

export function setupKeyboardShortcuts(
  store: EditorStore,
  editMode: EditMode,
  creatorMode: CreatorMode,
): void {
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingContext(event.target)) return;

    const state = store.getState();

    if (event.code === 'Space') {
      event.preventDefault();
      if (state.mode === 'create') {
        creatorMode.handleCreatorPlayPause();
      } else {
        void editMode.togglePlayPause();
      }
      return;
    }

    if (state.mode === 'edit') {
      if (event.key === 'I' || event.key === 'i') {
        event.preventDefault();
        if (state.duration <= 0) return;
        const nextStart = Math.min(editMode.getCurrentVideoTime(), Math.max(0, state.trimEnd - MIN_TRIM_GAP));
        editMode.applyTrimStart(nextStart);
        return;
      }
      if (event.key === 'O' || event.key === 'o') {
        event.preventDefault();
        if (state.duration <= 0) return;
        const nextEnd = Math.max(editMode.getCurrentVideoTime(), state.trimStart + MIN_TRIM_GAP);
        editMode.applyTrimEnd(nextEnd);
        return;
      }
      if (event.key === 'X' || event.key === 'x') {
        event.preventDefault();
        editMode.resetTrimToFullDuration();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.shiftKey ? 1 : 0.04;
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        editMode.seekBy(direction * step);
      }
    }

    if (state.mode === 'create') {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        const nextFrame = clamp(
          state.creatorFrame + direction * step,
          0,
          (state.composition?.config.durationInFrames ?? 1) - 1,
        );
        const player = creatorMode.getPreviewPlayer();
        if (player) {
          player.pause();
          store.setCreatorPlaying(false);
          player.seek(nextFrame);
        }
        store.setCreatorFrame(nextFrame);
      }
    }
  });
}

import { EditorStore } from './state';
import { createEditorUI, renderEditor } from './ui';
import { parseNumber } from './utils/time';

export function createEditorController(parent: HTMLElement): void {
  const store = new EditorStore();
  const ui = createEditorUI(parent);
  let activeObjectUrl: string | null = null;

  const setVideoSource = (src: string): void => {
    ui.video.src = src;
    ui.video.load();
  };

  const releaseActiveObjectUrl = (): void => {
    if (!activeObjectUrl) {
      return;
    }
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  };

  ui.loadUrlButton.addEventListener('click', () => {
    const url = ui.urlInput.value.trim();
    if (!url) {
      return;
    }

    releaseActiveObjectUrl();
    store.setSource('url', url, null);
    setVideoSource(url);
  });

  ui.pickFileButton.addEventListener('click', () => {
    ui.fileInput.click();
  });

  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    if (!file) {
      return;
    }

    releaseActiveObjectUrl();
    activeObjectUrl = URL.createObjectURL(file);
    store.setSource('file', file.name, activeObjectUrl);
    setVideoSource(activeObjectUrl);
  });

  ui.video.addEventListener('loadedmetadata', () => {
    store.setDuration(ui.video.duration || 0);
  });

  ui.video.addEventListener('timeupdate', () => {
    store.setCurrentTime(ui.video.currentTime || 0);

    const state = store.getState();
    if (state.loopPreview && ui.video.currentTime >= state.trimEnd) {
      ui.video.currentTime = state.trimStart;
      void ui.video.play();
    }
  });

  ui.video.addEventListener('play', () => {
    store.setPlaying(true);
  });

  ui.video.addEventListener('pause', () => {
    store.setPlaying(false);
  });

  const applyTrimStart = (value: number): void => {
    if (Number.isNaN(value)) {
      return;
    }
    const ok = store.setTrim({ trimStart: value });
    if (!ok) {
      return;
    }

    const state = store.getState();
    if (ui.video.currentTime < state.trimStart || ui.video.currentTime > state.trimEnd) {
      ui.video.currentTime = state.trimStart;
    }
  };

  const applyTrimEnd = (value: number): void => {
    if (Number.isNaN(value)) {
      return;
    }
    const ok = store.setTrim({ trimEnd: value });
    if (!ok) {
      return;
    }

    const state = store.getState();
    if (ui.video.currentTime > state.trimEnd) {
      ui.video.currentTime = state.trimStart;
    }
  };

  ui.startRange.addEventListener('input', () => {
    applyTrimStart(parseNumber(ui.startRange.value));
  });

  ui.endRange.addEventListener('input', () => {
    applyTrimEnd(parseNumber(ui.endRange.value));
  });

  ui.startInput.addEventListener('change', () => {
    applyTrimStart(parseNumber(ui.startInput.value));
  });

  ui.endInput.addEventListener('change', () => {
    applyTrimEnd(parseNumber(ui.endInput.value));
  });

  ui.loopButton.addEventListener('click', async () => {
    const state = store.getState();
    const nextLoop = !state.loopPreview;
    store.setLoopPreview(nextLoop);

    if (nextLoop) {
      ui.video.currentTime = state.trimStart;
      await ui.video.play().catch(() => undefined);
      return;
    }

    ui.video.pause();
  });

  store.subscribe((state) => {
    renderEditor(ui, state);
  });

  window.addEventListener('beforeunload', () => {
    releaseActiveObjectUrl();
  });
}

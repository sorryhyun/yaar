import type { EditorUI } from './ui';
import type { EditorStore } from './state';
import type { EditorPrefs } from './prefs';
import { normalizeStoragePath, getStorageApi, toStorageUrl, collectStorageVideoPaths } from './storage-utils';
import {
  MIN_TRIM_GAP,
  describeDiscardedTracks,
  extensionForFormat,
  makeExportFilename,
  pickOutputFormat,
  sourceForVideoUrl,
} from './export-utils';
import { clamp } from './utils/time';
import { errMsg, showPrompt } from '@bundled/yaar';
import { ALL_FORMATS, BufferTarget, Conversion, Input, Output } from '@bundled/mediabunny';

export interface EditMode {
  loadSourceUrl(url: string, storagePath?: string | null): boolean;
  setVideoSource(src: string): void;
  releaseActiveObjectUrl(): void;
  setFromFile(file: File): void;
  seekBy(deltaSeconds: number): void;
  togglePlayPause(): Promise<void>;
  applyTrimStart(value: number): void;
  applyTrimEnd(value: number): void;
  resetTrimToFullDuration(): void;
  exportTrimmedSegment(): Promise<void>;
  tryPickStorageVideo(): Promise<boolean>;
  getCurrentVideoTime(): number;
}

export function createEditMode(
  ui: EditorUI,
  store: EditorStore,
  opts: {
    getPrefs(): EditorPrefs;
    persistPrefs(patch: Partial<EditorPrefs>): void;
  },
): EditMode {
  let activeObjectUrl: string | null = null;
  let exportingInProgress = false;

  const releaseActiveObjectUrl = (): void => {
    if (!activeObjectUrl) return;
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  };

  const setVideoSource = (src: string): void => {
    ui.video.src = src;
    ui.video.playbackRate = opts.getPrefs().playbackRate;
    ui.video.load();
  };

  const loadSourceUrl = (url: string, storagePath: string | null = null): boolean => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return false;

    releaseActiveObjectUrl();
    const prefsPatch: Partial<EditorPrefs> = { lastUrl: trimmedUrl };
    if (storagePath !== null) {
      prefsPatch.lastStoragePath = normalizeStoragePath(storagePath);
    }
    opts.persistPrefs(prefsPatch);
    ui.urlInput.value = trimmedUrl;
    store.setSource('url', trimmedUrl, null);
    setVideoSource(trimmedUrl);
    return true;
  };

  const setFromFile = (file: File): void => {
    releaseActiveObjectUrl();
    activeObjectUrl = URL.createObjectURL(file);
    store.setSource('file', file.name, activeObjectUrl);
    setVideoSource(activeObjectUrl);
  };

  const seekBy = (deltaSeconds: number): void => {
    const duration = ui.video.duration || 0;
    if (duration <= 0) return;
    const nextTime = clamp((ui.video.currentTime || 0) + deltaSeconds, 0, duration);
    ui.video.currentTime = nextTime;
  };

  const togglePlayPause = async (): Promise<void> => {
    if (ui.video.paused) {
      await ui.video.play().catch(() => undefined);
      return;
    }
    ui.video.pause();
  };

  const applyTrimStart = (value: number): void => {
    if (Number.isNaN(value)) return;
    const ok = store.setTrim({ trimStart: value });
    if (!ok) return;
    const state = store.getState();
    if (ui.video.currentTime < state.trimStart || ui.video.currentTime > state.trimEnd) {
      ui.video.currentTime = state.trimStart;
    }
  };

  const applyTrimEnd = (value: number): void => {
    if (Number.isNaN(value)) return;
    const ok = store.setTrim({ trimEnd: value });
    if (!ok) return;
    const state = store.getState();
    if (ui.video.currentTime > state.trimEnd) {
      ui.video.currentTime = state.trimStart;
    }
  };

  const resetTrimToFullDuration = (): void => {
    const state = store.getState();
    if (state.duration <= 0) return;
    const ok = store.setTrim({ trimStart: 0, trimEnd: state.duration });
    if (!ok) return;
    ui.video.currentTime = 0;
  };

  const exportTrimmedSegment = async (): Promise<void> => {
    if (exportingInProgress) return;

    const state = store.getState();
    if (state.duration <= 0) {
      store.setExportState({ exportMessage: 'Load a video before exporting.' });
      return;
    }

    const trimStart = clamp(state.trimStart, 0, state.duration);
    const trimEnd = clamp(state.trimEnd, 0, state.duration);
    const selectedDuration = trimEnd - trimStart;
    if (selectedDuration <= MIN_TRIM_GAP) {
      store.setExportState({ exportMessage: 'Trim range is too small to export.' });
      return;
    }

    const sourceUrl = ui.video.currentSrc || ui.video.src;
    if (!sourceUrl) {
      store.setExportState({ exportMessage: 'No active media source to export.' });
      return;
    }

    exportingInProgress = true;
    store.setExportState({
      exporting: true,
      exportProgress: 0,
      exportMessage: 'Preparing export...',
    });

    // The trim runs entirely off the file's bytes, so the preview keeps playing
    // untouched. The previous implementation had to pause the preview, play a
    // hidden copy of the video in real time to feed MediaRecorder, and restore
    // the playhead afterwards — a 10-minute clip took 10 minutes, re-encoded
    // lossily, and dropped audio.
    let input: Input | null = null;

    try {
      input = new Input({ source: await sourceForVideoUrl(sourceUrl), formats: ALL_FORMATS });

      const outputFormat = await pickOutputFormat(input);
      const buffer = new BufferTarget();
      const conversion = await Conversion.init({
        input,
        output: new Output({ format: outputFormat, target: buffer }),
        trim: { start: trimStart, end: trimEnd },
      });

      if (!conversion.isValid) {
        throw new Error(
          describeDiscardedTracks(conversion.discardedTracks) ||
            'This video cannot be trimmed in this browser.',
        );
      }

      conversion.onProgress = (progress) => {
        store.setExportState({
          exportProgress: clamp(progress, 0, 1),
          exportMessage: `Exporting ${Math.round(progress * 100)}%`,
        });
      };

      await conversion.execute();

      if (!buffer.buffer) {
        throw new Error('Export produced an empty file.');
      }

      const outputBlob = new Blob([buffer.buffer], { type: outputFormat.mimeType });
      const anchor = document.createElement('a');
      const downloadUrl = URL.createObjectURL(outputBlob);
      anchor.href = downloadUrl;
      anchor.download = makeExportFilename(extensionForFormat(outputFormat));
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);

      const dropped = describeDiscardedTracks(conversion.discardedTracks);
      store.setExportState({
        exporting: false,
        exportProgress: 1,
        exportMessage: `Export complete. Downloaded ${selectedDuration.toFixed(2)}s clip.${
          dropped ? ` (${dropped})` : ''
        }`,
      });
    } catch (error) {
      const message = errMsg(error);
      store.setExportState({
        exporting: false,
        exportProgress: 0,
        exportMessage: `Export failed: ${message}`,
      });
    } finally {
      exportingInProgress = false;
      await input?.dispose();
    }
  };

  const tryPickStorageVideo = async (): Promise<boolean> => {
    const storageApi = getStorageApi();
    if (!storageApi) return false;

    let storageVideos: string[] = [];
    try {
      storageVideos = await collectStorageVideoPaths(storageApi);
    } catch {
      return false;
    }

    if (!storageVideos.length) return false;

    storageVideos.sort((a, b) => a.localeCompare(b));
    const prefs = opts.getPrefs();
    const fallbackPath = storageVideos[0];
    const defaultPath = storageVideos.includes(prefs.lastStoragePath) ? prefs.lastStoragePath : fallbackPath;

    const previewList = storageVideos.slice(0, 12).map((path, index) => `${index + 1}. ${path}`).join('\n');
    const extraCount = storageVideos.length - 12;
    const extraText = extraCount > 0 ? `\n...and ${extraCount} more` : '';

    const selectionRaw = await showPrompt(
      `Pick a storage video (number or path):\n${previewList}${extraText}`,
      { title: 'Storage video', initial: defaultPath },
    );
    if (selectionRaw === null) return false;

    const selection = selectionRaw.trim();
    if (!selection) return false;

    let selectedPath = '';
    const selectedIndex = Number(selection);
    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= storageVideos.length) {
      selectedPath = storageVideos[selectedIndex - 1];
    } else {
      selectedPath = normalizeStoragePath(selection);
    }

    if (!selectedPath) return false;

    return loadSourceUrl(toStorageUrl(selectedPath), selectedPath);
  };

  return {
    loadSourceUrl,
    setVideoSource,
    releaseActiveObjectUrl,
    setFromFile,
    seekBy,
    togglePlayPause,
    applyTrimStart,
    applyTrimEnd,
    resetTrimToFullDuration,
    exportTrimmedSegment,
    tryPickStorageVideo,
    getCurrentVideoTime: () => ui.video.currentTime || 0,
  };
}

import type { EditorUI } from './ui';
import type { EditorStore } from './state';
import type { EditorPrefs } from './prefs';
import { normalizeStoragePath, getStorageApi, toStorageUrl, collectStorageVideoPaths } from './storage-utils';
import {
  MIN_TRIM_GAP,
  EXPORT_PROGRESS_TICK_MS,
  pickExportMimeType,
  exportExtensionFromMimeType,
  makeExportFilename,
  waitForLoadedMetadata,
} from './export-utils';
import { clamp } from './utils/time';

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

    const mimeType = pickExportMimeType();
    if (typeof MediaRecorder === 'undefined') {
      store.setExportState({ exportMessage: 'MediaRecorder is not available in this browser.' });
      return;
    }

    const wasPlaying = !ui.video.paused;
    const resumeTime = ui.video.currentTime || 0;

    const exporterVideo = document.createElement('video');
    exporterVideo.src = sourceUrl;
    exporterVideo.preload = 'auto';
    exporterVideo.playsInline = true;
    exporterVideo.muted = true;
    exporterVideo.volume = 0;

    const chunks: BlobPart[] = [];
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    let progressTimer = 0;

    exportingInProgress = true;
    store.setExportState({
      exporting: true,
      exportProgress: 0,
      exportMessage: 'Preparing export...',
    });

    try {
      await waitForLoadedMetadata(exporterVideo);
      exporterVideo.currentTime = trimStart;

      const streamVideo = exporterVideo as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const captureStreamFn =
        streamVideo.captureStream?.bind(streamVideo) ?? streamVideo.mozCaptureStream?.bind(streamVideo);
      if (!captureStreamFn) {
        throw new Error('This browser does not support capturing media streams from video.');
      }

      stream = captureStreamFn() as MediaStream;

      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      });

      const stopped = new Promise<void>((resolve, reject) => {
        recorder!.addEventListener('stop', () => resolve(), { once: true });
        recorder!.addEventListener('error', () => reject(new Error('Recorder failed while exporting.')), {
          once: true,
        });
      });

      recorder.start(250);

      progressTimer = window.setInterval(() => {
        const elapsed = clamp(exporterVideo.currentTime - trimStart, 0, selectedDuration);
        const progress = clamp(elapsed / selectedDuration, 0, 1);
        store.setExportState({
          exportProgress: progress,
          exportMessage: `Exporting ${Math.round(progress * 100)}%`,
        });

        if (exporterVideo.currentTime >= trimEnd - 0.01 && recorder && recorder.state !== 'inactive') {
          recorder.stop();
        }
      }, EXPORT_PROGRESS_TICK_MS);

      await exporterVideo.play();
      await stopped;

      const blobType = mimeType || recorder.mimeType || 'video/webm';
      const outputBlob = new Blob(chunks, { type: blobType });
      if (outputBlob.size <= 0) {
        throw new Error('Export produced an empty file.');
      }

      const extension = exportExtensionFromMimeType(blobType);
      const anchor = document.createElement('a');
      const downloadUrl = URL.createObjectURL(outputBlob);
      anchor.href = downloadUrl;
      anchor.download = makeExportFilename(extension);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);

      store.setExportState({
        exporting: false,
        exportProgress: 1,
        exportMessage: `Export complete. Downloaded ${selectedDuration.toFixed(2)}s clip.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown export error.';
      store.setExportState({
        exporting: false,
        exportProgress: 0,
        exportMessage: `Export failed: ${message}`,
      });
    } finally {
      exportingInProgress = false;
      window.clearInterval(progressTimer);
      exporterVideo.pause();
      exporterVideo.removeAttribute('src');
      exporterVideo.load();

      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
      stream?.getTracks().forEach((track) => track.stop());

      ui.video.currentTime = clamp(resumeTime, 0, state.duration);
      if (wasPlaying) {
        await ui.video.play().catch(() => undefined);
      }
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

    const selectionRaw = window.prompt(
      `Pick a storage video (number or path):\n${previewList}${extraText}`,
      defaultPath,
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

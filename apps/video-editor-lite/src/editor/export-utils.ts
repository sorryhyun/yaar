export const MIN_TRIM_GAP = 0.01;
export const EXPORT_PROGRESS_TICK_MS = 120;
export const EXPORT_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
] as const;

export function pickExportMimeType(): string {
  if (typeof MediaRecorder === 'undefined') {
    return '';
  }

  for (const candidate of EXPORT_MIME_CANDIDATES) {
    if (!candidate || MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return '';
}

export function exportExtensionFromMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) {
    return 'mp4';
  }
  return 'webm';
}

export function makeExportFilename(extension: string, prefix = 'trim'): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${prefix}-${stamp}.${extension}`;
}

export function waitForLoadedMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };

    const onError = (): void => {
      cleanup();
      reject(new Error('Unable to read video metadata for export.'));
    };

    const cleanup = (): void => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

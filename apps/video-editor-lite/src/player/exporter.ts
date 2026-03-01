import { CompositionRenderer } from '../core/composition';
import type { Composition } from '../core/types';

const EXPORT_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of EXPORT_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  percent: number;
}

export async function exportComposition(
  composition: Composition,
  onProgress?: (p: ExportProgress) => void,
): Promise<Blob> {
  const { config } = composition;
  const renderer = new CompositionRenderer(composition);

  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext('2d')!;

  const mimeType = pickMime();
  if (!mimeType) {
    throw new Error('No supported video MIME type found for MediaRecorder.');
  }

  const stream = canvas.captureStream(config.fps);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: BlobPart[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data?.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('MediaRecorder error during export.'));
  });

  recorder.start(100);

  // Render every frame sequentially
  for (let frame = 0; frame < config.durationInFrames; frame++) {
    renderer.renderFrame(ctx, frame);

    onProgress?.({
      frame,
      totalFrames: config.durationInFrames,
      percent: (frame + 1) / config.durationInFrames,
    });

    // Yield to browser so MediaRecorder can capture the frame
    await new Promise((r) => requestAnimationFrame(r));
  }

  recorder.stop();
  stream.getTracks().forEach((t) => t.stop());
  await stopped;

  return new Blob(chunks, { type: mimeType });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

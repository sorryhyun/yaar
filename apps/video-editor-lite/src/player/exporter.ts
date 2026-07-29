import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type OutputFormat,
  type VideoCodec,
} from '@bundled/mediabunny';
import { CompositionRenderer } from '../core/composition';
import type { Composition } from '../core/types';

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  percent: number;
}

export interface CompositionExport {
  blob: Blob;
  /** Container extension actually produced — 'mp4' or 'webm'. */
  extension: string;
}

interface EncodeTarget {
  codec: VideoCodec;
  format: OutputFormat;
}

/**
 * Pick a container + codec this machine can actually encode.
 *
 * WebCodecs support is per codec AND per platform, so asking is the only way to
 * know. mp4 is tried first because it plays everywhere; webm is the fallback.
 * Returning null here is a real outcome — better to say so before rendering
 * hundreds of frames than to fail at the first `add()`.
 */
async function pickEncodeTarget(width: number, height: number): Promise<EncodeTarget | null> {
  for (const format of [new Mp4OutputFormat(), new WebMOutputFormat()]) {
    const codec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), {
      width,
      height,
    });
    if (codec) return { codec, format };
  }
  return null;
}

/**
 * Render every frame of a composition into a video file.
 *
 * Each frame is drawn and handed to the encoder with an explicit timestamp, so
 * the output is frame-exact regardless of how long a frame took to draw. (The
 * previous implementation recorded `canvas.captureStream()` through
 * MediaRecorder in real time, which silently dropped or duplicated frames
 * whenever rendering fell behind the clock.) Awaiting each `add` also applies
 * the encoder's backpressure, so a long composition can't outrun the encoder.
 */
export async function exportComposition(
  composition: Composition,
  onProgress?: (p: ExportProgress) => void,
): Promise<CompositionExport> {
  const { config } = composition;
  const renderer = new CompositionRenderer(composition);

  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext('2d')!;

  const target = await pickEncodeTarget(config.width, config.height);
  if (!target) {
    throw new Error(
      `No video encoder available for ${config.width}x${config.height} in this browser.`,
    );
  }

  const buffer = new BufferTarget();
  const output = new Output({ format: target.format, target: buffer });
  const source = new CanvasSource(canvas, { codec: target.codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: config.fps });

  await output.start();

  const frameDuration = 1 / config.fps;
  for (let frame = 0; frame < config.durationInFrames; frame++) {
    renderer.renderFrame(ctx, frame);
    await source.add(frame * frameDuration, frameDuration);

    onProgress?.({
      frame,
      totalFrames: config.durationInFrames,
      percent: (frame + 1) / config.durationInFrames,
    });
  }

  await output.finalize();

  if (!buffer.buffer) {
    throw new Error('Export produced an empty file.');
  }

  return {
    blob: new Blob([buffer.buffer], { type: target.format.mimeType }),
    extension: target.format.fileExtension.replace(/^\./, ''),
  };
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

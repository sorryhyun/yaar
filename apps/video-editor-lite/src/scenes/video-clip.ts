import type { Scene, VideoConfig } from '../core/types';
import { interpolate } from '../core/interpolate';
import { registerScene } from '../core/scene-registry';

export interface VideoClipProps {
  src: string;
  trimStart?: number; // seconds into the source video
  trimEnd?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  fadeIn?: number;
  fadeOut?: number;
}

// Cache of preloaded video elements
const videoCache = new Map<string, HTMLVideoElement>();

export function preloadVideoClip(src: string): Promise<HTMLVideoElement> {
  const cached = videoCache.get(src);
  if (cached && cached.readyState >= 2) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.oncanplay = () => {
      videoCache.set(src, video);
      resolve(video);
    };
    video.onerror = () => reject(new Error(`Failed to load video: ${src}`));
    video.src = src;
    video.load();
  });
}

class VideoClipScene implements Scene {
  id: string;
  type = 'video-clip';
  from: number;
  durationInFrames: number;
  private props: VideoClipProps;

  constructor(id: string, from: number, durationInFrames: number, props: VideoClipProps) {
    this.id = id;
    this.from = from;
    this.durationInFrames = durationInFrames;
    this.props = props;

    preloadVideoClip(props.src).catch(() => {});
  }

  render(ctx: CanvasRenderingContext2D, frame: number, config: VideoConfig): void {
    const video = videoCache.get(this.props.src);
    if (!video || video.readyState < 2) return;

    const {
      trimStart = 0,
      opacity = 1,
      fadeIn = 0,
      fadeOut = 0,
    } = this.props;

    // Sync video time to composition frame
    const targetTime = trimStart + frame / config.fps;
    if (Math.abs(video.currentTime - targetTime) > 0.05) {
      video.currentTime = targetTime;
    }

    // Fade handling
    let alpha = opacity;
    if (fadeIn > 0) {
      alpha *= interpolate(frame, [0, fadeIn], [0, 1]);
    }
    if (fadeOut > 0) {
      alpha *= interpolate(
        frame,
        [this.durationInFrames - fadeOut, this.durationInFrames],
        [1, 0],
      );
    }
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

    const dx = this.props.x ?? 0;
    const dy = this.props.y ?? 0;
    const dw = this.props.width ?? config.width;
    const dh = this.props.height ?? config.height;

    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.globalAlpha = 1;
  }
}

registerScene('video-clip', (id, from, dur, props) => new VideoClipScene(id, from, dur, props as unknown as VideoClipProps));

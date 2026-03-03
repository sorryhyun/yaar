import type { Scene, VideoConfig } from '../core/types';
import { interpolate, Easing } from '../core/interpolate';
import { registerScene } from '../core/scene-registry';

export interface ImageProps {
  src: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill';
  opacity?: number;
  fadeIn?: number; // frames
  fadeOut?: number; // frames
  kenBurns?: { startScale?: number; endScale?: number; startX?: number; endX?: number; startY?: number; endY?: number };
}

// Shared preload cache
const imageCache = new Map<string, HTMLImageElement>();

export function preloadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached?.complete) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

class ImageScene implements Scene {
  id: string;
  type = 'image';
  from: number;
  durationInFrames: number;
  props: ImageProps;

  constructor(id: string, from: number, durationInFrames: number, props: ImageProps) {
    this.id = id;
    this.from = from;
    this.durationInFrames = durationInFrames;
    this.props = props;

    // Start preloading
    preloadImage(props.src).catch(() => {});
  }

  render(ctx: CanvasRenderingContext2D, frame: number, config: VideoConfig): void {
    const img = imageCache.get(this.props.src);
    if (!img?.complete) return;

    const {
      fit = 'cover',
      opacity = 1,
      fadeIn = 0,
      fadeOut = 0,
      kenBurns,
    } = this.props;

    // Calculate opacity with fade
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

    let dx = this.props.x ?? 0;
    let dy = this.props.y ?? 0;
    let dw = this.props.width ?? config.width;
    let dh = this.props.height ?? config.height;

    if (fit === 'cover' || fit === 'contain') {
      const imgRatio = img.naturalWidth / img.naturalHeight;
      const targetRatio = dw / dh;
      if ((fit === 'cover') === (imgRatio > targetRatio)) {
        const scaledW = dh * imgRatio;
        dx -= (scaledW - dw) / 2;
        dw = scaledW;
      } else {
        const scaledH = dw / imgRatio;
        dy -= (scaledH - dh) / 2;
        dh = scaledH;
      }
    }

    ctx.save();

    // Ken Burns effect
    if (kenBurns) {
      const progress = interpolate(frame, [0, this.durationInFrames - 1], [0, 1], {
        easing: Easing.linear,
      });
      const scale = interpolate(progress, [0, 1], [kenBurns.startScale ?? 1, kenBurns.endScale ?? 1.2]);
      const panX = interpolate(progress, [0, 1], [kenBurns.startX ?? 0, kenBurns.endX ?? 0]);
      const panY = interpolate(progress, [0, 1], [kenBurns.startY ?? 0, kenBurns.endY ?? 0]);

      const centerX = dx + dw / 2;
      const centerY = dy + dh / 2;
      ctx.translate(centerX + panX, centerY + panY);
      ctx.scale(scale, scale);
      ctx.translate(-centerX, -centerY);
    }

    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

registerScene('image', (id, from, dur, props) => new ImageScene(id, from, dur, props as unknown as ImageProps));

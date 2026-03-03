import type { Scene, VideoConfig } from '../core/types';
import { interpolate } from '../core/interpolate';
import { registerScene } from '../core/scene-registry';

export interface SolidProps {
  color?: string;
  colorEnd?: string; // Animated transition to this color
  gradient?: { colors: string[]; angle?: number };
}

class SolidScene implements Scene {
  id: string;
  type = 'solid';
  from: number;
  durationInFrames: number;
  props: SolidProps;

  constructor(id: string, from: number, durationInFrames: number, props: SolidProps) {
    this.id = id;
    this.from = from;
    this.durationInFrames = durationInFrames;
    this.props = props;
  }

  render(ctx: CanvasRenderingContext2D, frame: number, config: VideoConfig): void {
    const { color = '#000000', colorEnd, gradient } = this.props;

    if (gradient && Array.isArray(gradient.colors) && gradient.colors.length >= 2) {
      const angle = gradient.angle ?? 0;
      const rad = (angle * Math.PI) / 180;
      const cx = config.width / 2;
      const cy = config.height / 2;
      const len = Math.sqrt(config.width ** 2 + config.height ** 2) / 2;
      const dx = Math.cos(rad) * len;
      const dy = Math.sin(rad) * len;

      const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
      const step = 1 / (gradient.colors.length - 1);
      gradient.colors.forEach((c, i) => grad.addColorStop(i * step, c));

      ctx.fillStyle = grad;
    } else if (colorEnd) {
      // Animate between two colors using opacity blending
      const progress = interpolate(frame, [0, this.durationInFrames - 1], [0, 1]);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, config.width, config.height);
      ctx.globalAlpha = progress;
      ctx.fillStyle = colorEnd;
    } else {
      ctx.fillStyle = color;
    }

    ctx.fillRect(0, 0, config.width, config.height);
    ctx.globalAlpha = 1;
  }
}

registerScene('solid', (id, from, dur, props) => new SolidScene(id, from, dur, props as SolidProps));

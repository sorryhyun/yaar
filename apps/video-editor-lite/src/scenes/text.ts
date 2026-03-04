import type { Scene, VideoConfig } from '../core/types';
import { interpolate, spring, Easing } from '../core/interpolate';
import { registerScene } from '../core/scene-registry';

export type TextAnimation =
  | 'none' | 'fadeIn' | 'fadeOut' | 'fade'
  | 'slideUp' | 'slideDown' | 'typewriter'
  | 'scale' | 'spring' | 'glitch' | 'blurIn' | 'bounce';

export interface TextProps {
  text: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  x?: number;
  y?: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  animation?: TextAnimation;
  animationDuration?: number;
  strokeColor?: string;
  strokeWidth?: number;
  shadow?: { color?: string; blur?: number; offsetX?: number; offsetY?: number };
}

const DEFAULT_ANIM_FRAMES = 15;

class TextScene implements Scene {
  id: string;
  type = 'text';
  from: number;
  durationInFrames: number;
  props: TextProps;

  constructor(id: string, from: number, durationInFrames: number, props: TextProps) {
    this.id = id;
    this.from = from;
    this.durationInFrames = durationInFrames;
    this.props = props;
  }

  render(ctx: CanvasRenderingContext2D, frame: number, config: VideoConfig): void {
    const {
      text,
      fontSize = 48,
      fontFamily = 'sans-serif',
      color = '#ffffff',
      x = 0.5,
      y = 0.5,
      align = 'center',
      baseline = 'middle',
      animation = 'none',
      animationDuration = DEFAULT_ANIM_FRAMES,
      strokeColor,
      strokeWidth,
      shadow,
    } = this.props;

    const px = x * config.width;
    const py = y * config.height;

    let opacity = 1;
    let offsetY = 0;
    let scaleVal = 1;
    let displayText = text;

    switch (animation) {
      case 'fadeIn':
        opacity = interpolate(frame, [0, animationDuration], [0, 1]);
        break;

      case 'fadeOut':
        opacity = interpolate(
          frame,
          [this.durationInFrames - animationDuration, this.durationInFrames],
          [1, 0],
        );
        break;

      case 'fade':
        opacity = Math.min(
          interpolate(frame, [0, animationDuration], [0, 1]),
          interpolate(
            frame,
            [this.durationInFrames - animationDuration, this.durationInFrames],
            [1, 0],
          ),
        );
        break;

      case 'slideUp':
        offsetY = interpolate(frame, [0, animationDuration], [60, 0], { easing: Easing.easeOut });
        opacity = interpolate(frame, [0, animationDuration], [0, 1]);
        break;

      case 'slideDown':
        offsetY = interpolate(frame, [0, animationDuration], [-60, 0], { easing: Easing.easeOut });
        opacity = interpolate(frame, [0, animationDuration], [0, 1]);
        break;

      case 'typewriter': {
        const charsToShow = Math.floor(
          interpolate(frame, [0, this.durationInFrames * 0.6], [0, text.length]),
        );
        displayText = text.slice(0, charsToShow);
        break;
      }

      case 'scale':
        scaleVal = interpolate(frame, [0, animationDuration], [0, 1], { easing: Easing.easeOut });
        opacity = interpolate(frame, [0, Math.min(animationDuration, 5)], [0, 1]);
        break;

      case 'spring':
        scaleVal = spring({ frame, fps: config.fps, damping: 8, stiffness: 80 });
        break;

      case 'bounce': {
        // Overshoot scale on entry then settle
        const progress = Math.min(frame / Math.max(animationDuration, 1), 1);
        scaleVal = spring({ frame: Math.floor(progress * config.fps * 0.8), fps: config.fps, damping: 6, stiffness: 120, mass: 0.8 });
        scaleVal = Math.max(0, scaleVal);
        opacity = interpolate(frame, [0, Math.min(8, animationDuration)], [0, 1]);
        break;
      }

      case 'blurIn':
        opacity = interpolate(frame, [0, animationDuration], [0, 1]);
        break;

      case 'glitch':
        opacity = 1;
        break;

      default:
        break;
    }

    ctx.save();

    // Apply blur filter for blurIn
    if (animation === 'blurIn') {
      const blurPx = interpolate(frame, [0, animationDuration], [20, 0], { easing: Easing.easeOut });
      if (blurPx > 0.3) ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
    }

    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));

    if (shadow) {
      ctx.shadowColor = shadow.color ?? 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = shadow.blur ?? 4;
      ctx.shadowOffsetX = shadow.offsetX ?? 2;
      ctx.shadowOffsetY = shadow.offsetY ?? 2;
    }

    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;

    ctx.translate(px, py + offsetY);
    if (scaleVal !== 1) ctx.scale(scaleVal, scaleVal);

    if (animation === 'glitch') {
      // Deterministic pseudo-random per frame for consistent look
      const seed = ((frame * 7 + 3) * 2654435761) >>> 0;
      const norm = (seed % 1000) / 1000;
      const glitchActive = norm < 0.3; // 30% of frames have glitch
      const shift = glitchActive ? Math.floor(norm * 24 - 6) : 0;
      const jitterY = glitchActive ? Math.floor(((seed >> 8) % 5) - 2) : 0;

      if (glitchActive && shift !== 0) {
        // Red channel (right shift)
        ctx.fillStyle = '#ff2244';
        ctx.globalAlpha = 0.55;
        ctx.fillText(displayText, shift, jitterY + 2);
        // Cyan channel (left shift)
        ctx.fillStyle = '#00ffcc';
        ctx.fillText(displayText, -shift, jitterY - 2);
        ctx.globalAlpha = opacity;
      }

      // Main text
      if (strokeColor && strokeWidth) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeWidth;
        ctx.strokeText(displayText, 0, 0);
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = opacity;
      ctx.fillText(displayText, 0, 0);
    } else {
      if (strokeColor && strokeWidth) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeWidth;
        ctx.strokeText(displayText, 0, 0);
      }
      ctx.fillStyle = color;
      ctx.fillText(displayText, 0, 0);
    }

    ctx.restore();

    // Reset globals
    ctx.globalAlpha = 1;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.filter = 'none';
  }
}

registerScene('text', (id, from, dur, props) => new TextScene(id, from, dur, props as unknown as TextProps));

import type { Scene, VideoConfig } from '../core/types';
import { interpolate, spring, Easing } from '../core/interpolate';
import { registerScene } from '../core/scene-registry';

export type TextAnimation = 'none' | 'fadeIn' | 'fadeOut' | 'fade' | 'slideUp' | 'slideDown' | 'typewriter' | 'scale' | 'spring';

export interface TextProps {
  text: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  x?: number; // 0-1 normalized, default 0.5 (center)
  y?: number; // 0-1 normalized, default 0.5 (center)
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  animation?: TextAnimation;
  animationDuration?: number; // frames for in/out animations
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
  private props: TextProps;

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

    ctx.save();
    ctx.translate(px, py + offsetY);
    if (scaleVal !== 1) {
      ctx.scale(scaleVal, scaleVal);
    }

    if (strokeColor && strokeWidth) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.strokeText(displayText, 0, 0);
    }

    ctx.fillStyle = color;
    ctx.fillText(displayText, 0, 0);
    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
}

registerScene('text', (id, from, dur, props) => new TextScene(id, from, dur, props as unknown as TextProps));

import type { Scene, VideoConfig } from '../core/types';
import { interpolate, Easing } from '../core/interpolate';
import { registerScene } from '../core/scene-registry';

export type ShapeType = 'rect' | 'circle' | 'roundedRect' | 'line';

export interface ShapeKeyframe {
  frame: number; // relative frame
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  radius?: number;
  opacity?: number;
  rotation?: number; // degrees
  scaleX?: number;
  scaleY?: number;
}

export interface ShapeProps {
  shape: ShapeType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  radius?: number;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  opacity?: number;
  rotation?: number;
  cornerRadius?: number; // for roundedRect
  keyframes?: ShapeKeyframe[];
  // line-specific
  x2?: number;
  y2?: number;
}

function interpolateKeyframes(
  frame: number,
  keyframes: ShapeKeyframe[],
  prop: keyof ShapeKeyframe,
  defaultVal: number,
): number {
  if (!keyframes.length) return defaultVal;

  const frames: number[] = [];
  const values: number[] = [];

  for (const kf of keyframes) {
    const val = kf[prop];
    if (typeof val === 'number') {
      frames.push(kf.frame);
      values.push(val);
    }
  }

  if (!frames.length) return defaultVal;
  if (frames.length === 1) return values[0];

  return interpolate(frame, frames, values, { easing: Easing.easeInOut });
}

class ShapeScene implements Scene {
  id: string;
  type = 'shape';
  from: number;
  durationInFrames: number;
  props: ShapeProps;

  constructor(id: string, from: number, durationInFrames: number, props: ShapeProps) {
    this.id = id;
    this.from = from;
    this.durationInFrames = durationInFrames;
    this.props = props;
  }

  render(ctx: CanvasRenderingContext2D, frame: number, config: VideoConfig): void {
    const { shape, color = '#ffffff', strokeColor, strokeWidth = 2, keyframes = [], cornerRadius = 8 } = this.props;

    const x = interpolateKeyframes(frame, keyframes, 'x', this.props.x ?? config.width / 4);
    const y = interpolateKeyframes(frame, keyframes, 'y', this.props.y ?? config.height / 4);
    const w = interpolateKeyframes(frame, keyframes, 'width', this.props.width ?? 200);
    const h = interpolateKeyframes(frame, keyframes, 'height', this.props.height ?? 200);
    const r = interpolateKeyframes(frame, keyframes, 'radius', this.props.radius ?? 100);
    const opacity = interpolateKeyframes(frame, keyframes, 'opacity', this.props.opacity ?? 1);
    const rotation = interpolateKeyframes(frame, keyframes, 'rotation', this.props.rotation ?? 0);

    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));

    ctx.save();
    if (rotation !== 0) {
      const cx = shape === 'circle' ? x : x + w / 2;
      const cy = shape === 'circle' ? y : y + h / 2;
      ctx.translate(cx, cy);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }

    ctx.beginPath();

    switch (shape) {
      case 'rect':
        ctx.rect(x, y, w, h);
        break;
      case 'roundedRect':
        ctx.roundRect(x, y, w, h, cornerRadius);
        break;
      case 'circle':
        ctx.arc(x, y, r, 0, Math.PI * 2);
        break;
      case 'line': {
        const x2 = this.props.x2 ?? x + w;
        const y2 = this.props.y2 ?? y;
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        break;
      }
    }

    if (shape !== 'line') {
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (strokeColor) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

registerScene('shape', (id, from, dur, props) => new ShapeScene(id, from, dur, props as unknown as ShapeProps));

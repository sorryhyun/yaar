import { CompositionRenderer } from '../core/composition';
import type { Composition } from '../core/types';

export type PlayerState = 'idle' | 'playing' | 'paused';

export class PreviewPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private renderer: CompositionRenderer;
  private currentFrame = 0;
  private state: PlayerState = 'idle';
  private rafId = 0;
  private lastTimestamp = 0;
  private onFrameChange?: (frame: number) => void;

  constructor(canvas: HTMLCanvasElement, composition: Composition) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.renderer = new CompositionRenderer(composition);

    canvas.width = composition.config.width;
    canvas.height = composition.config.height;
  }

  setComposition(composition: Composition): void {
    this.renderer.setComposition(composition);
    this.canvas.width = composition.config.width;
    this.canvas.height = composition.config.height;
    this.renderCurrentFrame();
  }

  setOnFrameChange(cb: (frame: number) => void): void {
    this.onFrameChange = cb;
  }

  play(): void {
    if (this.state === 'playing') return;

    const config = this.renderer.config;
    if (this.currentFrame >= config.durationInFrames - 1) {
      this.currentFrame = 0;
    }

    this.state = 'playing';
    this.lastTimestamp = 0;
    this.rafId = requestAnimationFrame((ts) => this.tick(ts));
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    cancelAnimationFrame(this.rafId);
  }

  seek(frame: number): void {
    const config = this.renderer.config;
    this.currentFrame = Math.max(0, Math.min(frame, config.durationInFrames - 1));
    this.renderCurrentFrame();
  }

  getCurrentFrame(): number {
    return this.currentFrame;
  }

  getState(): PlayerState {
    return this.state;
  }

  getRenderer(): CompositionRenderer {
    return this.renderer;
  }

  destroy(): void {
    this.pause();
    this.state = 'idle';
  }

  private tick(timestamp: number): void {
    if (this.state !== 'playing') return;

    if (this.lastTimestamp === 0) {
      this.lastTimestamp = timestamp;
    }

    const deltaMs = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;

    const config = this.renderer.config;
    const frameDelta = (deltaMs / 1000) * config.fps;
    this.currentFrame += frameDelta;

    if (this.currentFrame >= config.durationInFrames) {
      this.currentFrame = 0; // loop
    }

    this.renderCurrentFrame();
    this.rafId = requestAnimationFrame((ts) => this.tick(ts));
  }

  private renderCurrentFrame(): void {
    const frame = Math.floor(this.currentFrame);
    this.renderer.renderFrame(this.ctx, frame);
    this.onFrameChange?.(frame);
  }
}

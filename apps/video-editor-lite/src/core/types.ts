export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export interface Scene {
  id: string;
  type: string;
  from: number;
  durationInFrames: number;
  render(ctx: CanvasRenderingContext2D, frame: number, config: VideoConfig): void;
}

export interface Composition {
  config: VideoConfig;
  scenes: Scene[];
}

export const DEFAULT_CONFIG: VideoConfig = {
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 150, // 5 seconds at 30fps
};

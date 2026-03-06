import { v4 as uuid } from '@bundled/uuid';

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

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  scenes: Scene[];
}

export interface Composition {
  config: VideoConfig;
  layers: Layer[];
}

/** Flatten all scenes across all layers in render order (bottom layer first) */
export function getAllScenes(composition: Composition): Scene[] {
  return composition.layers.flatMap((l) => l.scenes);
}

/** Find which layer contains a scene ID */
export function findLayerForScene(composition: Composition, sceneId: string): Layer | null {
  return composition.layers.find((l) => l.scenes.some((s) => s.id === sceneId)) ?? null;
}

export const DEFAULT_CONFIG: VideoConfig = {
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 150,
};

export function nextLayerId(): string {
  return uuid();
}

export function makeDefaultLayer(name = 'Layer 1'): Layer {
  return { id: nextLayerId(), name, visible: true, locked: false, scenes: [] };
}

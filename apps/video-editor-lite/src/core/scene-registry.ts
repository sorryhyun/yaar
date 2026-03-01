import type { Scene } from './types';

export type SceneProps = Record<string, unknown>;
export type SceneFactory = (id: string, from: number, durationInFrames: number, props: SceneProps) => Scene;

const registry = new Map<string, SceneFactory>();

export function registerScene(type: string, factory: SceneFactory): void {
  registry.set(type, factory);
}

export function createScene(
  type: string,
  id: string,
  from: number,
  durationInFrames: number,
  props: SceneProps,
): Scene {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(`Unknown scene type: "${type}". Registered: ${[...registry.keys()].join(', ')}`);
  }
  return factory(id, from, durationInFrames, props);
}

export function getRegisteredTypes(): string[] {
  return [...registry.keys()];
}

import type { Composition, Scene, VideoConfig } from './types';

export class CompositionRenderer {
  private composition: Composition;

  constructor(composition: Composition) {
    this.composition = composition;
  }

  get config(): VideoConfig {
    return this.composition.config;
  }

  get scenes(): Scene[] {
    return this.composition.scenes;
  }

  setComposition(composition: Composition): void {
    this.composition = composition;
  }

  renderFrame(ctx: CanvasRenderingContext2D, frameNumber: number): void {
    const { config, scenes } = this.composition;

    // Clear canvas
    ctx.clearRect(0, 0, config.width, config.height);

    // Render active scenes in order (later = on top)
    for (const scene of scenes) {
      const sceneEnd = scene.from + scene.durationInFrames;
      if (frameNumber >= scene.from && frameNumber < sceneEnd) {
        const relativeFrame = frameNumber - scene.from;
        ctx.save();
        scene.render(ctx, relativeFrame, config);
        ctx.restore();
      }
    }
  }

  getActiveScenes(frameNumber: number): Scene[] {
    return this.composition.scenes.filter((scene) => {
      const sceneEnd = scene.from + scene.durationInFrames;
      return frameNumber >= scene.from && frameNumber < sceneEnd;
    });
  }
}

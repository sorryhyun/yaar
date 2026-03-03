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
    ctx.clearRect(0, 0, config.width, config.height);
    for (const scene of scenes) {
      const sceneEnd = scene.from + scene.durationInFrames;
      if (frameNumber >= scene.from && frameNumber < sceneEnd) {
        const relativeFrame = frameNumber - scene.from;
        ctx.save();
        try {
          scene.render(ctx, relativeFrame, config);
        } catch (e) {
          // Draw an error indicator instead of crashing
          ctx.fillStyle = 'rgba(255,0,0,0.3)';
          ctx.fillRect(0, 0, config.width, config.height);
          ctx.fillStyle = '#fff';
          ctx.font = '24px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`Scene error: ${scene.type}`, config.width / 2, config.height / 2);
        }
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

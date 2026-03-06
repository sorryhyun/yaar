import type { Composition, Scene, VideoConfig } from './types';

export class CompositionRenderer {
  private composition: Composition;

  constructor(composition: Composition) {
    this.composition = composition;
  }

  get config(): VideoConfig {
    return this.composition.config;
  }

  get layers() {
    return this.composition.layers;
  }

  setComposition(composition: Composition): void {
    this.composition = composition;
  }

  renderFrame(ctx: CanvasRenderingContext2D, frameNumber: number): void {
    const { config, layers } = this.composition;
    ctx.clearRect(0, 0, config.width, config.height);
    for (const layer of layers) {
      if (!layer.visible) continue;
      for (const scene of layer.scenes) {
        const sceneEnd = scene.from + scene.durationInFrames;
        if (frameNumber >= scene.from && frameNumber < sceneEnd) {
          const relativeFrame = frameNumber - scene.from;
          ctx.save();
          try {
            scene.render(ctx, relativeFrame, config);
          } catch (e) {
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
  }

  getActiveScenes(frameNumber: number): Scene[] {
    const result: Scene[] = [];
    for (const layer of this.composition.layers) {
      if (!layer.visible) continue;
      for (const scene of layer.scenes) {
        const sceneEnd = scene.from + scene.durationInFrames;
        if (frameNumber >= scene.from && frameNumber < sceneEnd) {
          result.push(scene);
        }
      }
    }
    return result;
  }
}

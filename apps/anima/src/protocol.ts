import { app, defineCommand, errMsg } from '@bundled/yaar';
import type { Bucket } from './buckets';
import { listSavedImages } from './appfiles';

export type GenerationOptions = {
  prompt: string;
  seed?: number;
  ratio?: string;
};

export type GenerationResult = Record<string, unknown> & {
  ok: boolean;
  prompt?: string;
  seed?: number;
  ratio?: string;
  dataUrl?: string | null;
  error?: string;
};

export type ProtocolDeps = {
  getStatus: () => string;
  getBusy: () => boolean;
  getProgress: () => { label: string; pct: number | null } | null;
  getLastResult: () => GenerationResult | null;
  setLastResult: (result: GenerationResult | null) => void;
  setPrompt: (value: string) => void;
  setSeed: (value: number) => void;
  setRatio: (value: string) => void;
  getCapabilities: () => string;
  buckets: Bucket[];
  /** Runs the pipeline *and* persists the PNG; returns the storage-stamped result. */
  generate: (options: GenerationOptions) => Promise<unknown>;
};

export function registerProtocol(deps: ProtocolDeps): void {
  if (!app) return;

  app.register({
    appId: 'anima',
    name: 'Anima (WebGPU)',
    events: {
      progress: {
        description: 'Generation progress changed. Payload: { label, pct, busy }.',
      },
      generated: {
        description: 'A protocol generation finished. Payload is the same stable result exposed by lastResult.',
      },
      generationError: {
        description: 'A protocol generation failed. Payload: { error, prompt, seed, ratio }.',
      },
    },
    state: {
      status: {
        description: 'Current pipeline status, including whether generation is active and the latest UI message',
        handler: () => ({
          busy: deps.getBusy(),
          phase: deps.getBusy() ? 'generating' : deps.getLastResult()?.ok ? 'completed' : deps.getLastResult() ? 'error' : 'idle',
          message: deps.getStatus(),
          capabilities: deps.getCapabilities(),
        }),
      },
      progress: {
        description: 'Current progress as { label, pct }, where pct may be null while indeterminate',
        handler: () => deps.getProgress(),
      },
      lastResult: {
        description: 'Stable result from the most recent generation, including storagePath/storageUrl or a fallback dataUrl',
        handler: () => deps.getLastResult(),
      },
      savedImages: {
        description:
          'Previously generated images held in app storage (yaar://apps/anima/storage/generated/), newest first',
        handler: async () => {
          try {
            return await listSavedImages();
          } catch {
            return [];
          }
        },
      },
      options: {
        description: 'Safe generation options supported by the generate command',
        handler: () => ({
          ratios: deps.buckets.map((b) => ({ id: b.id, label: b.label, width: b.W, height: b.H })),
          defaults: { seed: 0, ratio: deps.buckets[0]?.id ?? '512x512' },
        }),
      },
    },
    commands: {
      generate: defineCommand({
        description:
          'Generate one image with Anima in-browser WebGPU and wait for the full text encoder → DiT → VAE pipeline. ' +
          'First use can take several minutes while multi-GB model weights load; use a long command timeout and query status/progress/lastResult if transport times out.',
        params: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Image description. Required and must not be blank.' },
            seed: { type: 'number', description: 'Deterministic signed 32-bit seed (default 0).' },
            ratio: {
              type: 'string',
              enum: ['512x512', '624x416', '416x624', '688x384', '384x688'],
              description: 'Output size/aspect bucket (default 512x512).',
            },
          },
          required: ['prompt'],
        },
        handler: async (params) => {
          const prompt = params.prompt.trim();
          if (!prompt) throw new Error('prompt must not be blank');
          if (deps.getBusy()) throw new Error('Anima is already generating an image');

          const seed = (params.seed ?? 0) | 0;
          const ratio = params.ratio ?? deps.buckets[0]?.id ?? '512x512';
          deps.setPrompt(prompt);
          deps.setSeed(seed);
          deps.setRatio(ratio);

          try {
            // `deps.generate` is the single funnel for every generation — it paints the
            // canvas, writes the PNG into app storage, and stamps storagePath/storageUrl
            // onto the result. Saving here too would write the image twice.
            const result = (await deps.generate({ prompt, seed, ratio })) as GenerationResult;
            if (!result.ok) {
              app.emit('generationError', { error: result.error ?? 'Generation failed', prompt, seed, ratio });
              return result;
            }
            app.emit('generated', result);
            return result;
          } catch (error) {
            const result: GenerationResult = { ok: false, error: errMsg(error), prompt, seed, ratio };
            deps.setLastResult(result);
            app.emit('generationError', result);
            throw error;
          }
        },
      }),
    },
  });
}

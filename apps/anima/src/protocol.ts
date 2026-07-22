import { app, defineCommand, errMsg } from '@bundled/yaar';
import type { Bucket } from './buckets';
import { listSavedImages } from './appfiles';
import { publishImage } from './publish';

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
  /** Generates many images behind a single text-encode phase; persists each PNG. */
  batchGenerate: (requests: GenerationOptions[]) => Promise<unknown>;
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
        description:
          'A protocol generation finished. Payload is the same stable result exposed by lastResult.',
      },
      generationError: {
        description: 'A protocol generation failed. Payload: { error, prompt, seed, ratio }.',
      },
    },
    state: {
      status: {
        description:
          'Current pipeline status, including whether generation is active and the latest UI message',
        handler: () => ({
          busy: deps.getBusy(),
          phase: deps.getBusy()
            ? 'generating'
            : deps.getLastResult()?.ok
              ? 'completed'
              : deps.getLastResult()
                ? 'error'
                : 'idle',
          message: deps.getStatus(),
          capabilities: deps.getCapabilities(),
        }),
      },
      progress: {
        description:
          'Current progress as { label, pct }, where pct may be null while indeterminate',
        handler: () => deps.getProgress(),
      },
      lastResult: {
        description:
          'Stable result from the most recent generation, including storagePath/storageUrl or a fallback dataUrl',
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
            prompt: {
              type: 'string',
              description: 'Image description. Required and must not be blank.',
            },
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
              app.emit('generationError', {
                error: result.error ?? 'Generation failed',
                prompt,
                seed,
                ratio,
              });
              return result;
            }
            app.emit('generated', result);
            return result;
          } catch (error) {
            const result: GenerationResult = {
              ok: false,
              error: errMsg(error),
              prompt,
              seed,
              ratio,
            };
            deps.setLastResult(result);
            app.emit('generationError', result);
            throw error;
          }
        },
      }),
      batchGenerate: defineCommand({
        description:
          'Generate several images in one call, sharing a single text-encode pass. Use this ' +
          'instead of calling generate repeatedly: all prompts are encoded while the 1.46 GB ' +
          'text model is loaded once (a big saving for distinct prompts), then the DiT/VAE run ' +
          'per request grouped by ratio. Returns { ok, count, okCount, results } where results ' +
          'preserves request order; each entry is the same shape as generate. First use can take ' +
          'minutes while multi-GB weights load — use a long timeout and query status/progress if ' +
          'transport times out. Duplicate prompts are encoded once; omit a seed to get one per ' +
          'request (defaults to its index).',
        params: {
          type: 'object',
          properties: {
            requests: {
              type: 'array',
              minItems: 1,
              description: 'Images to generate, in order.',
              items: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'Image description. Required and must not be blank.',
                  },
                  seed: {
                    type: 'number',
                    description: 'Deterministic signed 32-bit seed (defaults to the request index).',
                  },
                  ratio: {
                    type: 'string',
                    enum: ['512x512', '624x416', '416x624', '688x384', '384x688'],
                    description: 'Output size/aspect bucket (default 512x512).',
                  },
                },
                required: ['prompt'],
              },
            },
          },
          required: ['requests'],
        },
        handler: async (params) => {
          if (deps.getBusy()) throw new Error('Anima is already generating an image');
          const raw = Array.isArray(params.requests) ? params.requests : [];
          const requests = raw.map((r: GenerationOptions) => ({
            prompt: String(r?.prompt ?? '').trim(),
            seed: r?.seed,
            ratio: r?.ratio,
          }));
          if (requests.length === 0) throw new Error('requests must be a non-empty array');
          if (requests.some((r) => !r.prompt)) throw new Error('every request needs a prompt');

          const batch = (await deps.batchGenerate(requests)) as {
            ok: boolean;
            results?: GenerationResult[];
            error?: string;
          };
          // Mirror the per-image events the single `generate` command emits, so
          // subscribers (UI, agents) see each result as it would from a solo call.
          for (const result of batch.results ?? []) {
            if (result?.ok) app.emit('generated', result);
            else
              app.emit('generationError', {
                error: result?.error ?? 'Generation failed',
                prompt: result?.prompt,
                seed: result?.seed,
                ratio: result?.ratio,
              });
          }
          return batch;
        },
      }),
      publish: defineCommand({
        description:
          'Publish a generated image to the shared media tree (yaar://storage/media/anima/), ' +
          'where other apps can reach it — e.g. so devtools can import it as an asset for an ' +
          'app it is building. Defaults to the most recent generation; pass `image` (a name or ' +
          'storage path from savedImages) to pick another. The bytes are copied server-side, so ' +
          "this is cheap regardless of image size. Anima's own gallery is unaffected.",
        params: {
          type: 'object',
          properties: {
            image: {
              type: 'string',
              description:
                'Name or storage path of a saved image (see the savedImages state). Omit for the newest.',
            },
            as: {
              type: 'string',
              description:
                'File name to publish under. Defaults to the saved name. Useful for something ' +
                'a person can recognize, e.g. "dragon.png".',
            },
          },
        },
        handler: async (params) => {
          try {
            return await publishImage(
              params.image ? String(params.image) : undefined,
              params.as ? String(params.as) : undefined,
            );
          } catch (error) {
            throw new Error(errMsg(error));
          }
        },
      }),
    },
  });
}

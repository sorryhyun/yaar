import { defineAppCommand } from '@bundled/yaar';
import { ctl } from './controller';

export const sourceCommands = {
  loadSource: defineAppCommand({
    description: 'Load a media source by direct URL or storage path.',
    params: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        path: { type: 'string', description: 'Path under /api/storage/.' },
      },
      additionalProperties: false,
    },
    run: (params) =>
      ctl().loadSource({
        url: typeof params.url === 'string' ? params.url : undefined,
        path: typeof params.path === 'string' ? params.path : undefined,
      }),
  }),
  play: defineAppCommand({
    description: 'Start playback (edit mode: video, create mode: composition preview).',
    params: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ctl().play(),
  }),
  pause: defineAppCommand({
    description: 'Pause playback.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    run: () => ctl().pause(),
  }),
  seek: defineAppCommand({
    description: 'Seek to an absolute playback time in seconds.',
    params: {
      type: 'object',
      properties: { time: { type: 'number', minimum: 0 } },
      required: ['time'],
      additionalProperties: false,
    },
    run: (params) => {
      const time = typeof params.time === 'number' ? params.time : Number.NaN;
      return ctl().seek(time);
    },
  }),
  setPlaybackRate: defineAppCommand({
    description: 'Set playback speed. Allowed values: 0.5, 1, 1.5, 2.',
    params: {
      type: 'object',
      properties: { rate: { type: 'number', enum: [0.5, 1, 1.5, 2] } },
      required: ['rate'],
      additionalProperties: false,
    },
    run: (params) => {
      const rate = typeof params.rate === 'number' ? params.rate : Number.NaN;
      return ctl().setPlaybackRate(rate);
    },
  }),
};

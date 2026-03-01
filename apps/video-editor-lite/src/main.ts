import { createEditorController } from './editor/controller';

type AppProtocolStateEntry = {
  description: string;
  handler: () => unknown | Promise<unknown>;
};

type AppProtocolCommandEntry = {
  description: string;
  params: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (params: Record<string, unknown>) => unknown | Promise<unknown>;
};

type YaarAppApi = {
  register: (manifest: {
    appId: string;
    name: string;
    state: Record<string, AppProtocolStateEntry>;
    commands: Record<string, AppProtocolCommandEntry>;
  }) => void;
};

const controller = createEditorController(document.body);

const appApi = (window as { yaar?: { app?: unknown } }).yaar?.app as YaarAppApi | undefined;
if (appApi && typeof appApi.register === 'function') {
  appApi.register({
    appId: 'video-editor-lite',
    name: 'Video Editor Lite',
    state: {
      currentSource: {
        description: 'Current media source information.',
        handler: () => controller.getCurrentSource(),
      },
      playbackState: {
        description: 'Playback status including play/pause, loop preview, and rate.',
        handler: () => controller.getPlaybackState(),
      },
      timeline: {
        description: 'Current playback time and total duration in seconds.',
        handler: () => controller.getTimeline(),
      },
      trimRange: {
        description: 'Current trim in/out range and selected duration in seconds.',
        handler: () => controller.getTrimRange(),
      },
    },
    commands: {
      loadSource: {
        description: 'Load a media source by direct URL or storage path.',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            path: { type: 'string', description: 'Path under /api/storage/.' },
          },
          additionalProperties: false,
        },
        handler: (params) =>
          controller.loadSource({
            url: typeof params.url === 'string' ? params.url : undefined,
            path: typeof params.path === 'string' ? params.path : undefined,
          }),
      },
      play: {
        description: 'Start playback.',
        params: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        handler: async () => controller.play(),
      },
      pause: {
        description: 'Pause playback.',
        params: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        handler: () => controller.pause(),
      },
      seek: {
        description: 'Seek to an absolute playback time in seconds.',
        params: {
          type: 'object',
          properties: {
            time: { type: 'number', minimum: 0 },
          },
          required: ['time'],
          additionalProperties: false,
        },
        handler: (params) => {
          const time = typeof params.time === 'number' ? params.time : Number.NaN;
          return controller.seek(time);
        },
      },
      setPlaybackRate: {
        description: 'Set playback speed. Allowed values: 0.5, 1, 1.5, 2.',
        params: {
          type: 'object',
          properties: {
            rate: { type: 'number', enum: [0.5, 1, 1.5, 2] },
          },
          required: ['rate'],
          additionalProperties: false,
        },
        handler: (params) => {
          const rate = typeof params.rate === 'number' ? params.rate : Number.NaN;
          return controller.setPlaybackRate(rate);
        },
      },
    },
  });
}

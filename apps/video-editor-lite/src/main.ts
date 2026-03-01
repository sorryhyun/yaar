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
      composition: {
        description: 'Current composition state including config and scenes.',
        handler: () => controller.getComposition(),
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
        description: 'Start playback (edit mode: video, create mode: composition preview).',
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
      createComposition: {
        description: 'Create a new video composition. Switches to Create mode. Default: 1280x720 @ 30fps, 150 frames (5s).',
        params: {
          type: 'object',
          properties: {
            width: { type: 'number', description: 'Canvas width in pixels' },
            height: { type: 'number', description: 'Canvas height in pixels' },
            fps: { type: 'number', description: 'Frames per second' },
            durationInFrames: { type: 'number', description: 'Total composition length in frames' },
          },
          additionalProperties: false,
        },
        handler: (params) =>
          controller.createComposition({
            width: typeof params.width === 'number' ? params.width : undefined,
            height: typeof params.height === 'number' ? params.height : undefined,
            fps: typeof params.fps === 'number' ? params.fps : undefined,
            durationInFrames: typeof params.durationInFrames === 'number' ? params.durationInFrames : undefined,
          }),
      },
      addScene: {
        description: 'Add a scene to the composition. Types: solid, text, shape, image, video-clip.',
        params: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['solid', 'text', 'shape', 'image', 'video-clip'] },
            from: { type: 'number', description: 'Start frame (default: 0)' },
            durationInFrames: { type: 'number', description: 'Scene duration in frames' },
            props: {
              type: 'object',
              description: 'Scene-specific properties. solid: {color, colorEnd, gradient}. text: {text, fontSize, fontFamily, color, x, y, align, animation, shadow}. shape: {shape, x, y, width, height, radius, color, strokeColor, keyframes}. image: {src, fit, kenBurns}. video-clip: {src, trimStart, trimEnd}.',
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
        handler: (params) =>
          controller.addScene({
            type: params.type as string,
            from: typeof params.from === 'number' ? params.from : undefined,
            durationInFrames: typeof params.durationInFrames === 'number' ? params.durationInFrames : undefined,
            props: typeof params.props === 'object' && params.props ? (params.props as Record<string, unknown>) : undefined,
          }),
      },
      updateScene: {
        description: 'Update an existing scene by ID.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            from: { type: 'number' },
            durationInFrames: { type: 'number' },
            props: { type: 'object', description: 'Updated scene properties (merged with defaults).' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        handler: (params) =>
          controller.updateScene({
            id: params.id as string,
            from: typeof params.from === 'number' ? params.from : undefined,
            durationInFrames: typeof params.durationInFrames === 'number' ? params.durationInFrames : undefined,
            props: typeof params.props === 'object' && params.props ? (params.props as Record<string, unknown>) : undefined,
          }),
      },
      removeScene: {
        description: 'Remove a scene by ID.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        handler: (params) => controller.removeScene({ id: params.id as string }),
      },
      reorderScenes: {
        description: 'Reorder scenes by providing an array of IDs in the desired order.',
        params: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['ids'],
          additionalProperties: false,
        },
        handler: (params) => controller.reorderScenes({ ids: params.ids as string[] }),
      },
      preview: {
        description: 'Switch to Create mode and start playing the composition preview.',
        params: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        handler: () => controller.preview(),
      },
      exportVideo: {
        description: 'Export the composition as a WebM video file.',
        params: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        handler: async () => controller.exportVideo(),
      },
      getComposition: {
        description: 'Get the current composition state.',
        params: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        handler: () => controller.getComposition(),
      },
    },
  });
}

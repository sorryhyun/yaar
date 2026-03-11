import type { Composition } from './core/types';
import type { SceneProps } from './core/scene-registry';

export interface EditorControllerApi {
  getCurrentSource: () => { sourceKind: 'url' | 'file' | null; sourceValue: string; objectUrl: string | null };
  getPlaybackState: () => { playing: boolean; paused: boolean; playbackRate: number; loopPreview: boolean };
  getTimeline: () => { currentTime: number; duration: number };
  getTrimRange: () => { trimStart: number; trimEnd: number; selectedDuration: number };
  loadSource: (params: { url?: string; path?: string }) => { ok: true; source: string };
  play: () => Promise<{ ok: true }>;
  pause: () => { ok: true };
  seek: (time: number) => { ok: true; currentTime: number };
  setPlaybackRate: (rate: number) => { ok: true; playbackRate: number };
  // Creator mode API
  createComposition: (params: { width?: number; height?: number; fps?: number; durationInFrames?: number }) => { ok: true; config: Composition['config'] };
  addScene: (params: { type: string; from?: number; durationInFrames?: number; props?: SceneProps; layerId?: string }) => { ok: true; sceneId: string };
  updateScene: (params: { id: string; from?: number; durationInFrames?: number; props?: SceneProps }) => { ok: true };
  removeScene: (params: { id: string }) => { ok: true };
  reorderScenes: (params: { ids: string[] }) => { ok: true };
  getComposition: () => { composition: unknown };
  preview: () => { ok: true };
  exportVideo: () => Promise<{ ok: true }>;
  addLayer: (params: { name?: string; index?: number }) => { ok: true; layerId: string; layerName: string };
  removeLayer: (params: { id: string }) => { ok: true };
  updateLayer: (params: { id: string; name?: string; visible?: boolean; locked?: boolean }) => { ok: true };
  reorderLayers: (params: { ids: string[] }) => { ok: true };
  selectLayer: (params: { id: string }) => { ok: true };
  moveSceneToLayer: (params: { sceneId: string; layerId: string }) => { ok: true };
  getLayers: () => { layers: Array<{ id: string; name: string; visible: boolean; locked: boolean; sceneIds: string[] }> };
}

type AppProtocolStateEntry = {
  description: string;
  handler: () => unknown | Promise<unknown>;
};

type AppProtocolCommandEntry = {
  description: string;
  aliases?: string[];
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

export function registerProtocol(controller: EditorControllerApi): void {
  const appApi = (window as { yaar?: { app?: unknown } }).yaar?.app as YaarAppApi | undefined;
  if (!appApi || typeof appApi.register !== 'function') return;

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
      layers: {
        description: 'All layers in the current composition with their scenes.',
        handler: () => controller.getLayers(),
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
        params: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => controller.play(),
      },
      pause: {
        description: 'Pause playback.',
        params: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => controller.pause(),
      },
      seek: {
        description: 'Seek to an absolute playback time in seconds.',
        params: {
          type: 'object',
          properties: { time: { type: 'number', minimum: 0 } },
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
          properties: { rate: { type: 'number', enum: [0.5, 1, 1.5, 2] } },
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
        description: 'Add a scene to the composition. Types: solid, text, shape, image, video-clip. Optionally specify a layerId to target a specific layer (default: selected layer).',
        params: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['solid', 'text', 'shape', 'image', 'video-clip'] },
            from: { type: 'number', description: 'Start frame (default: 0)' },
            durationInFrames: { type: 'number', description: 'Scene duration in frames' },
            layerId: { type: 'string', description: 'Target layer ID (default: currently selected layer)' },
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
            layerId: typeof params.layerId === 'string' ? params.layerId : undefined,
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
        aliases: ['deleteScene'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        handler: (params) => controller.removeScene({ id: params.id as string }),
      },
      reorderScenes: {
        description: 'Reorder scenes by providing an array of IDs in the desired order.',
        params: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' } } },
          required: ['ids'],
          additionalProperties: false,
        },
        handler: (params) => controller.reorderScenes({ ids: params.ids as string[] }),
      },
      preview: {
        description: 'Switch to Create mode and start playing the composition preview.',
        params: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => controller.preview(),
      },
      exportVideo: {
        description: 'Export the composition as a WebM video file.',
        params: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => controller.exportVideo(),
      },
      getComposition: {
        description: 'Get the current composition state.',
        params: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => controller.getComposition(),
      },
      addLayer: {
        description: 'Add a new layer to the composition. Returns the new layer ID.',
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Layer name (default: "Layer N")' },
            index: { type: 'number', description: 'Insert position (0 = bottom/background). Default: top.' },
          },
          additionalProperties: false,
        },
        handler: (params) =>
          controller.addLayer({
            name: typeof params.name === 'string' ? params.name : undefined,
            index: typeof params.index === 'number' ? params.index : undefined,
          }),
      },
      removeLayer: {
        description: 'Remove a layer and all its scenes by layer ID. The last layer cannot be removed.',
        aliases: ['deleteLayer'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Layer ID to remove' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        handler: (params) => controller.removeLayer({ id: params.id as string }),
      },
      updateLayer: {
        description: 'Update layer properties: rename, toggle visibility, or toggle lock.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Layer ID' },
            name: { type: 'string', description: 'New layer name' },
            visible: { type: 'boolean', description: 'Layer visibility (hidden layers are not rendered or exported)' },
            locked: { type: 'boolean', description: 'Locked layers cannot have their scenes edited' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        handler: (params) =>
          controller.updateLayer({
            id: params.id as string,
            name: typeof params.name === 'string' ? params.name : undefined,
            visible: typeof params.visible === 'boolean' ? params.visible : undefined,
            locked: typeof params.locked === 'boolean' ? params.locked : undefined,
          }),
      },
      reorderLayers: {
        description: 'Reorder all layers. ids[0] = bottom (background), ids[last] = top (foreground).',
        params: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, description: 'Layer IDs in new order (bottom to top)' },
          },
          required: ['ids'],
          additionalProperties: false,
        },
        handler: (params) => controller.reorderLayers({ ids: params.ids as string[] }),
      },
      selectLayer: {
        description: 'Select the active layer. New scenes added via addScene will go into this layer.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Layer ID to select' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        handler: (params) => controller.selectLayer({ id: params.id as string }),
      },
      moveSceneToLayer: {
        description: 'Move a scene from its current layer to a different layer.',
        params: {
          type: 'object',
          properties: {
            sceneId: { type: 'string', description: 'Scene ID to move' },
            layerId: { type: 'string', description: 'Target layer ID' },
          },
          required: ['sceneId', 'layerId'],
          additionalProperties: false,
        },
        handler: (params) =>
          controller.moveSceneToLayer({
            sceneId: params.sceneId as string,
            layerId: params.layerId as string,
          }),
      },
    },
  });
}

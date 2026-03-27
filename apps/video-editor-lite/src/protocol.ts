import { app } from '@bundled/yaar';
import type { Composition } from './core/types';
import type { SceneProps } from './core/scene-registry';

export interface EditorControllerApi {
  getCurrentSource: () => { sourceKind: 'url' | 'file' | null; sourceValue: string; objectUrl: string | null };
  getPlaybackState: () => { playing: boolean; paused: boolean; playbackRate: number; loopPreview: boolean };
  getTimeline: () => { currentTime: number; duration: number };
  getTrimRange: () => { trimStart: number; trimEnd: number; selectedDuration: number };
  loadSource: (params: { url?: string; path?: string }) => { source: string };
  play: () => Promise<void>;
  pause: () => void;
  seek: (time: number) => { currentTime: number };
  setPlaybackRate: (rate: number) => { playbackRate: number };
  // Creator mode API
  createComposition: (params: { width?: number; height?: number; fps?: number; durationInFrames?: number }) => { config: Composition['config'] };
  addScene: (params: { type: string; from?: number; durationInFrames?: number; props?: SceneProps; layerId?: string }) => { sceneId: string };
  updateScene: (params: { id: string; from?: number; durationInFrames?: number; props?: SceneProps }) => void;
  removeScene: (params: { id: string }) => void;
  reorderScenes: (params: { ids: string[] }) => void;
  getComposition: () => { composition: unknown };
  preview: () => void;
  exportVideo: () => Promise<void>;
  addLayer: (params: { name?: string; index?: number }) => { layerId: string; layerName: string };
  removeLayer: (params: { id: string }) => void;
  updateLayer: (params: { id: string; name?: string; visible?: boolean; locked?: boolean }) => void;
  reorderLayers: (params: { ids: string[] }) => void;
  selectLayer: (params: { id: string }) => void;
  moveSceneToLayer: (params: { sceneId: string; layerId: string }) => void;
  getLayers: () => { layers: Array<{ id: string; name: string; visible: boolean; locked: boolean; sceneIds: string[] }> };
}

export function registerProtocol(controller: EditorControllerApi): void {
  if (!app || typeof app.register !== 'function') return;

  app.register({
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
        handler: (params: Record<string, unknown>) =>
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
        handler: (params: Record<string, unknown>) => {
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
        handler: (params: Record<string, unknown>) => {
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
        handler: (params: Record<string, unknown>) =>
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
              description: 'Scene-specific properties.',
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
        handler: (params: Record<string, unknown>) =>
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
        handler: (params: Record<string, unknown>) =>
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
        handler: (params: Record<string, unknown>) => controller.removeScene({ id: params.id as string }),
      },
      reorderScenes: {
        description: 'Reorder scenes by providing an array of IDs in the desired order.',
        params: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' } } },
          required: ['ids'],
          additionalProperties: false,
        },
        handler: (params: Record<string, unknown>) => controller.reorderScenes({ ids: params.ids as string[] }),
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
        handler: (params: Record<string, unknown>) =>
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
        handler: (params: Record<string, unknown>) => controller.removeLayer({ id: params.id as string }),
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
        handler: (params: Record<string, unknown>) =>
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
        handler: (params: Record<string, unknown>) => controller.reorderLayers({ ids: params.ids as string[] }),
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
        handler: (params: Record<string, unknown>) => controller.selectLayer({ id: params.id as string }),
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
        handler: (params: Record<string, unknown>) =>
          controller.moveSceneToLayer({
            sceneId: params.sceneId as string,
            layerId: params.layerId as string,
          }),
      },
    },
  });
}

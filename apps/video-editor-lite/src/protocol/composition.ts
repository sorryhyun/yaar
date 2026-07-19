import { defineCommand } from '@bundled/yaar';
import { ctl } from './controller';

export const compositionCommands = {
  createComposition: defineCommand({
    description:
      'Create a new video composition. Switches to Create mode. Default: 1280x720 @ 30fps, 150 frames (5s).',
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
      ctl().createComposition({
        width: typeof params.width === 'number' ? params.width : undefined,
        height: typeof params.height === 'number' ? params.height : undefined,
        fps: typeof params.fps === 'number' ? params.fps : undefined,
        durationInFrames:
          typeof params.durationInFrames === 'number' ? params.durationInFrames : undefined,
      }),
  }),
  addScene: defineCommand({
    description:
      'Add a scene to the composition. Types: solid, text, shape, image, video-clip. Optionally specify a layerId to target a specific layer (default: selected layer).',
    params: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['solid', 'text', 'shape', 'image', 'video-clip'] },
        from: { type: 'number', description: 'Start frame (default: 0)' },
        durationInFrames: { type: 'number', description: 'Scene duration in frames' },
        layerId: {
          type: 'string',
          description: 'Target layer ID (default: currently selected layer)',
        },
        props: {
          type: 'object',
          description: 'Scene-specific properties.',
        },
      },
      required: ['type'],
      additionalProperties: false,
    },
    handler: (params) =>
      ctl().addScene({
        type: params.type,
        from: typeof params.from === 'number' ? params.from : undefined,
        durationInFrames:
          typeof params.durationInFrames === 'number' ? params.durationInFrames : undefined,
        layerId: typeof params.layerId === 'string' ? params.layerId : undefined,
        props:
          typeof params.props === 'object' && params.props
            ? (params.props as Record<string, unknown>)
            : undefined,
      }),
  }),
  updateScene: defineCommand({
    description: 'Update an existing scene by ID.',
    params: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        from: { type: 'number' },
        durationInFrames: { type: 'number' },
        props: {
          type: 'object',
          description: 'Updated scene properties (merged with defaults).',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (params) =>
      ctl().updateScene({
        id: params.id,
        from: typeof params.from === 'number' ? params.from : undefined,
        durationInFrames:
          typeof params.durationInFrames === 'number' ? params.durationInFrames : undefined,
        props:
          typeof params.props === 'object' && params.props
            ? (params.props as Record<string, unknown>)
            : undefined,
      }),
  }),
  removeScene: defineCommand({
    description: 'Remove a scene by ID.',
    aliases: ['deleteScene'],
    params: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (params) => ctl().removeScene({ id: params.id }),
  }),
  reorderScenes: defineCommand({
    description: 'Reorder scenes by providing an array of IDs in the desired order.',
    params: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
      additionalProperties: false,
    },
    handler: (params) => ctl().reorderScenes({ ids: params.ids }),
  }),
  getComposition: defineCommand({
    description: 'Get the current composition state.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ctl().getComposition(),
  }),
};

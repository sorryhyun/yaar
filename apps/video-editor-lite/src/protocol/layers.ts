import { defineAppCommand } from '@bundled/yaar';
import { ctl } from './controller';

export const layerCommands = {
  addLayer: defineAppCommand({
    description: 'Add a new layer to the composition. Returns the new layer ID.',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Layer name (default: "Layer N")' },
        index: {
          type: 'number',
          description: 'Insert position (0 = bottom/background). Default: top.',
        },
      },
      additionalProperties: false,
    },
    run: (params) =>
      ctl().addLayer({
        name: typeof params.name === 'string' ? params.name : undefined,
        index: typeof params.index === 'number' ? params.index : undefined,
      }),
  }),
  removeLayer: defineAppCommand({
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
    run: (params) => ctl().removeLayer({ id: params.id }),
  }),
  updateLayer: defineAppCommand({
    description: 'Update layer properties: rename, toggle visibility, or toggle lock.',
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Layer ID' },
        name: { type: 'string', description: 'New layer name' },
        visible: {
          type: 'boolean',
          description: 'Layer visibility (hidden layers are not rendered or exported)',
        },
        locked: {
          type: 'boolean',
          description: 'Locked layers cannot have their scenes edited',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (params) =>
      ctl().updateLayer({
        id: params.id,
        name: typeof params.name === 'string' ? params.name : undefined,
        visible: typeof params.visible === 'boolean' ? params.visible : undefined,
        locked: typeof params.locked === 'boolean' ? params.locked : undefined,
      }),
  }),
  reorderLayers: defineAppCommand({
    description: 'Reorder all layers. ids[0] = bottom (background), ids[last] = top (foreground).',
    params: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Layer IDs in new order (bottom to top)',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    run: (params) => ctl().reorderLayers({ ids: params.ids }),
  }),
  selectLayer: defineAppCommand({
    description: 'Select the active layer. New scenes added via addScene will go into this layer.',
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Layer ID to select' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (params) => ctl().selectLayer({ id: params.id }),
  }),
  moveSceneToLayer: defineAppCommand({
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
    run: (params) =>
      ctl().moveSceneToLayer({
        sceneId: params.sceneId,
        layerId: params.layerId,
      }),
  }),
};

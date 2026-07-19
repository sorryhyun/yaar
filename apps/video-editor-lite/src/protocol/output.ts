import { defineCommand } from '@bundled/yaar';
import { ctl } from './controller';

export const outputCommands = {
  preview: defineCommand({
    description: 'Switch to Create mode and start playing the composition preview.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ctl().preview(),
  }),
  exportVideo: defineCommand({
    description: 'Export the composition as a WebM video file.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ctl().exportVideo(),
  }),
};

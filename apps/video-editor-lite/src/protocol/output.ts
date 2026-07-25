import { defineAppCommand } from '@bundled/yaar';
import { ctl } from './controller';

export const outputCommands = {
  preview: defineAppCommand({
    description: 'Switch to Create mode and start playing the composition preview.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    run: () => ctl().preview(),
  }),
  exportVideo: defineAppCommand({
    description: 'Export the composition as a WebM video file.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ctl().exportVideo(),
  }),
};

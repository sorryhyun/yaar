// Commands call the same actions the UI does, so a command and a click cannot diverge.
import { defineAppCommand } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { start, stop } from './actions';
import { status } from './store';

export const appState = {
  status: {
    description:
      "Whether a monitor agent's conversation is on claude.ai: running, the monitorId, and its sessionUrl.",
    get: () => status(),
  },
};

export const appCommands = {
  start: defineAppCommand({
    description:
      "Put this window's monitor agent on claude.ai. The user confirms in a dialog; resolves with the sessionUrl.",
    params: z.object({
      name: z.optional(z.string()),
    }),
    replay: 'never',
    run: async (p) => start(p),
  }),

  stop: defineAppCommand({
    description: 'Turn Remote Control off.',
    params: z.object({}),
    replay: 'never',
    run: async () => {
      await stop();
      return { running: false };
    },
  }),
};

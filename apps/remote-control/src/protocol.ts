// Commands call the same actions the UI does, so a command and a click cannot diverge.
import { defineAppCommand } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { pressEnter, refreshStatus, start, stop } from './actions';
import { PERMISSION_MODES } from './gateway';
import { status } from './store';

export const appState = {
  status: {
    description:
      'The host: running, state (starting/ready/exited), the monitorId it acts on, sessionUrl once ready, exitCode, and the terminal tail.',
    get: () => status(),
  },
};

export const appCommands = {
  start: defineAppCommand({
    description:
      "Turn Remote Control on for this window's monitor. The user confirms in a dialog; resolves at spawn, before the link exists — the status state turns ready when it does.",
    params: z.object({
      name: z.optional(z.string()),
      permissionMode: z.optional(z.enum(PERMISSION_MODES)),
      continue: z.optional(z.boolean()),
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

  pressEnter: defineAppCommand({
    description:
      'Send Enter to the host terminal, to accept a prompt the tail shows it waiting on.',
    params: z.object({}),
    replay: 'never',
    run: async () => {
      await pressEnter();
      return refreshStatus();
    },
  }),
};

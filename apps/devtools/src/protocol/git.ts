import { defineCommand } from '@bundled/yaar';
import { gitHistory, gitDiff, gitRestore, gitCheckpoint } from '../project';

export const gitCommands = {
  gitHistory: defineCommand({
    description: "List a deployed app's version history, newest first. Each deploy is one commit.",
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App to inspect' },
        limit: { type: 'number', description: 'Max commits (default 30)' },
      },
      required: ['appId'],
    },
    handler: async (p) =>
      gitHistory(String(p.appId), typeof p.limit === 'number' ? p.limit : undefined),
  }),
  gitDiff: defineCommand({
    description:
      'Diff a deployed app. against="snapshot" (default) compares its current files to a ' +
      'commit in its own history — what changed since the last deploy. against="repo" compares ' +
      "to the user's git repo — what has changed relative to what the user committed (bundled apps only).",
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App to diff' },
        ref: {
          type: 'string',
          description: 'Commit to compare against: a hash or HEAD~N. Default HEAD.',
        },
        against: { type: 'string', enum: ['snapshot', 'repo'] },
      },
      required: ['appId'],
    },
    handler: async (p) => {
      const result = await gitDiff(String(p.appId), {
        ref: p.ref ? String(p.ref) : undefined,
        against: p.against === 'repo' ? 'repo' : 'snapshot',
      });
      if (!result.diff) return { changed: false, files: [] };
      return {
        changed: true,
        files: result.files ?? [],
        diff: result.diff,
        ...(result.truncated ? { truncated: true } : {}),
      };
    },
  }),
  gitRestore: defineCommand({
    description:
      'Roll a deployed app back to an earlier commit and rebuild it. Use after a bad deploy. ' +
      'The current state is snapshotted first, so this is itself undoable.',
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App to roll back' },
        ref: {
          type: 'string',
          description:
            'Commit to restore: a hash from gitHistory, or HEAD~1 for the previous version.',
        },
      },
      required: ['appId', 'ref'],
    },
    handler: async (p) => gitRestore(String(p.appId), String(p.ref)),
  }),
  gitCheckpoint: defineCommand({
    description:
      "Snapshot a deployed app's current state as a commit, so you can return to it later.",
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App to snapshot' },
        message: { type: 'string', description: 'What this checkpoint captures' },
      },
      required: ['appId'],
    },
    handler: async (p) => gitCheckpoint(String(p.appId), p.message ? String(p.message) : undefined),
  }),
};

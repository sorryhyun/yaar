import { defineAppCommand } from '@bundled/yaar';
import { gitHistory, gitDiff, gitRestore, gitCheckpoint } from '../services';

export const gitCommands = {
  gitHistory: defineAppCommand({
    description: "List a deployed app's version history, newest first. Each deploy is one commit.",
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App to inspect' },
        limit: { type: 'number', description: 'Max commits (default 30)' },
      },
      required: ['appId'],
    },
    run: async (p) =>
      gitHistory(String(p.appId), typeof p.limit === 'number' ? p.limit : undefined),
  }),
  gitDiff: defineAppCommand({
    description:
      'Diff a deployed app against a commit. against="snapshot" (default): app\'s own deploy ' +
      'history. against="repo": user\'s git repo (bundled apps only). Start with ' +
      'statOnly: true — a whole-app diff runs to tens of kilobytes, and the per-file line ' +
      'counts it returns instead tell you which paths to then request in full.',
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App to diff' },
        ref: { type: 'string', description: 'Hash or HEAD~N. Default HEAD.' },
        against: { type: 'string', enum: ['snapshot', 'repo'] },
        statOnly: {
          type: 'boolean',
          description:
            'Return per-file { file, added, removed } counts instead of the diff text.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only these app-relative paths. Pass back what `files`/`stat` named, e.g. ' +
            '["src/main.ts"].',
        },
      },
      required: ['appId'],
    },
    run: async (p) => {
      const statOnly = p.statOnly === true;
      const result = await gitDiff(String(p.appId), {
        ref: p.ref ? String(p.ref) : undefined,
        against: p.against === 'repo' ? 'repo' : 'snapshot',
        statOnly,
        ...(Array.isArray(p.paths) ? { paths: p.paths.map((x) => String(x)) } : {}),
      });
      // Under statOnly there is no diff text by design, so emptiness has to be read
      // off the file list — testing `result.diff` would report every stat read as
      // "nothing changed".
      const files = result.files ?? [];
      if (statOnly) {
        if (files.length === 0) return { changed: false, files: [] };
        const stat = result.stat ?? [];
        return {
          changed: true,
          files,
          stat,
          totals: {
            files: stat.length,
            added: stat.reduce((n, s) => n + s.added, 0),
            removed: stat.reduce((n, s) => n + s.removed, 0),
          },
        };
      }
      if (!result.diff) return { changed: false, files: [] };
      return {
        changed: true,
        files,
        diff: result.diff,
        ...(result.truncated ? { truncated: true } : {}),
      };
    },
  }),
  gitRestore: defineAppCommand({
    description:
      'Roll a deployed app back to an earlier commit and rebuild it, overwriting current files. ' +
      'Current state is auto-snapshotted first, so this is itself undoable via another gitRestore.',
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App to roll back' },
        ref: {
          type: 'string',
          description: 'Hash from gitHistory, or HEAD~1 for previous version.',
        },
      },
      required: ['appId', 'ref'],
    },
    run: async (p) => gitRestore(String(p.appId), String(p.ref)),
  }),
  gitCheckpoint: defineAppCommand({
    description: "Snapshot a deployed app's current state as a restorable commit.",
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App to snapshot' },
        message: { type: 'string', description: 'What this checkpoint captures' },
      },
      required: ['appId'],
    },
    run: async (p) => gitCheckpoint(String(p.appId), p.message ? String(p.message) : undefined),
  }),
};

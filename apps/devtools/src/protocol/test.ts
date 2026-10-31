import { defineAppCommand } from '@bundled/yaar';
import { innerWaitMs } from '../lib';
import { DEFAULT_TEST_TIMEOUT_MS, runProjectTests } from '../services';

export const testCommands = {
  'test/run': defineAppCommand({
    description:
      "Run the active project's unit tests (every src/**/*.test.ts, against @bundled/test; " +
      'the unit-testing topic) in a minimized window under the preview principal; the open ' +
      'preview is untouched. Returns { pass, passed, failed, skipped, files, failures, ' +
      'loadErrors } with each failure named `describe > test` and its file, or { pass: false, ' +
      'stage, errors } when the tests did not build or load. Slow: raise the host wait to ' +
      '~120000 (the timeouts topic).',
    params: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Run only tests whose `describe > test` name or file contains this text ' +
            '(case-insensitive), e.g. to re-run one failure.',
        },
        verbose: {
          type: 'boolean',
          description:
            'Also return every test with its status and duration, not just the failures. ' +
            'Off by default: the reply is capped at 16KB.',
        },
        waitMs: {
          type: 'number',
          description: 'Inner wait for the run itself (default 60000, floor 1000, max 170000).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Older name for `waitMs`, which wins when both are passed.',
        },
      },
    },
    replay: 'never',
    run: async (p) =>
      await runProjectTests({
        filter: typeof p.filter === 'string' && p.filter.trim() ? p.filter.trim() : undefined,
        verbose: p.verbose === true,
        waitMs: innerWaitMs(p) ?? DEFAULT_TEST_TIMEOUT_MS,
      }),
  }),
};

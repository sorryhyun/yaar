import { defineAppCommand } from '@bundled/yaar';
import { runAllTests, suiteNames } from '../test';
import { DEFAULT_TEST_TIMEOUT_MS, runProjectTests } from '../services';

export const testCommands = {
  selfTest: defineAppCommand({
    description:
      "Run Dev Tools' OWN unit suite over its pure-logic layer (src/lib) and return " +
      '{ pass, passed, failed, suites, failures } — each failure naming its suite, its ' +
      'check and the assertion that broke. It tests this app, never the active project, ' +
      'so it needs no project open and touches no files. Run it after editing anything ' +
      'under src/lib, src/core or src/test; it is the check AGENTS.md points at, and it ' +
      'is fast enough that there is no reason to skip it before a deploy.',
    params: {
      type: 'object',
      properties: {
        suite: {
          type: 'string',
          description:
            'Run one suite instead of all of them, for re-running a failure. A name that ' +
            'matches nothing is reported as a failure, not as a pass over zero checks.',
        },
      },
    },
    run: (p) => {
      const only = p.suite ? String(p.suite) : undefined;
      return { ...runAllTests(only), available: suiteNames() };
    },
  }),
  runTests: defineAppCommand({
    description:
      "Run the ACTIVE PROJECT's unit tests: every src/**/*.test.ts, written against " +
      "`import { describe, test, expect } from '@bundled/test'` (a bun:test subset). They " +
      'are built into dist/test.html — beside the app, never into it, so tests never ship ' +
      'and the app build refuses @bundled/test — and run in a minimized window of their ' +
      "own with the preview's principal: real DOM, real @bundled/yaar, the preview's " +
      'throwaway storage. Returns { pass, passed, failed, skipped, files, failures, ' +
      'loadErrors } with each failure named `describe > test` and its file; or ' +
      '{ pass: false, stage, errors } when the tests did not build or load. The open ' +
      'preview is untouched. Call with this command timeoutMs raised to ~120000: the build ' +
      'and the run each take their own time. Test-only helpers belong in *.test.ts files ' +
      'or in src/test/ imported only by them; never import a test file from main.ts.',
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
        timeoutMs: {
          type: 'number',
          description:
            "Budget for the run itself (default 60000, max 170000). Raise this command's " +
            'own timeoutMs above it.',
        },
      },
    },
    replay: 'never',
    run: async (p) =>
      await runProjectTests({
        filter: typeof p.filter === 'string' && p.filter.trim() ? p.filter.trim() : undefined,
        verbose: p.verbose === true,
        timeoutMs: typeof p.timeoutMs === 'number' ? p.timeoutMs : DEFAULT_TEST_TIMEOUT_MS,
      }),
  }),
};

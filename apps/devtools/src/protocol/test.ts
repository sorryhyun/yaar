import { defineAppCommand } from '@bundled/yaar';
import { runAllTests, suiteNames } from '../test';

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
};

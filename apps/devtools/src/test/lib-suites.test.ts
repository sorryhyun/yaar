import { describe, test } from '@bundled/test';
import { libSuites } from './lib-suites';

// Dev Tools' pure-logic suites, run by `test/run` against the project as it stands —
// which, editing a devtools clone, is the clone and not the installed build.
for (const s of libSuites) {
  describe(s.name, () => {
    for (const check of s.checks) test(check.name, check.fn);
  });
}

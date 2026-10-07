---
name: unit-testing
description: Read before writing tests for an app, or when a fix needs a test that pins it — src/**/*.test.ts with @bundled/test, run by runTests.
audience: agent
---

## Unit tests with `runTests`

Put tests beside the code as `src/**/*.test.ts`, written against `@bundled/test` (a subset of
`bun:test`):

```ts
import { describe, test, expect } from '@bundled/test';
import { runRegex } from './regex';

describe('runRegex', () => {
  test('finds every match with g', () => {
    expect(runRegex('a', 'g', 'banana').matches.map((m) => m.start)).toEqual([1, 3, 5]);
  });
  test('reports a bad pattern instead of throwing', () => {
    expect(runRegex('(', '', '').error).toContain('Invalid');
  });
});
```

`runTests` builds them into `dist/test.html` and runs that page in a minimized window, so DOM,
`@bundled/yaar` and the preview's storage are all real. Re-run one failure with
`filter: "finds every match"`.

- **Never import a test file, or `@bundled/test`, from app code.** The app build refuses
  `@bundled/test`, which is what keeps tests out of the deployed bundle. Do not expose tests
  through `defineApp({ debug })` either.
- Helpers shared between tests go in a `*.test.ts`-only module (e.g. `src/test/fixtures.ts`)
  that only test files import.
- Keep the code under test importable without side effects: a test that imports `main.ts`
  mounts the whole app. Pure logic in its own module is what makes it testable.
- A test's `timeoutMs` stops a hung `await`, not a synchronous loop. A test that can hang the
  thread (a catastrophic regex) belongs in a worker, or the whole run times out.

Unit tests check functions. Behaviour across commands on a running app is `previewScript` (the
`regression-testing` topic); the two complement each other.

## Web Workers

`import MatchWorker from './match.worker.ts?worker'` bundles that file on its own and inlines it;
`new MatchWorker()` starts it as a module worker. Write the worker as an ordinary module that
imports what it needs — never stringify functions into a Blob. Inside it, `self.onmessage` /
`self.postMessage`; `@bundled/yaar` is refused there (the SDK lives on `window`). A worker is also
the only way to put a time limit on work that can block: `terminate()` it when it overruns.

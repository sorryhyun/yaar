export {};
import { runSuites, type RunResult } from './harness';
import { libSuites } from './lib-suites';

// Barrel for the unit suites. Kept beside the harness rather than in src/lib: this
// directory is the only one that may import across layers, because a test's whole job
// is to reach the thing it checks.

export * from './harness';
export { libSuites } from './lib-suites';

/** Run every suite, or one by name. Never throws — see runSuites. */
export function runAllTests(only?: string): RunResult {
  return runSuites(libSuites, only);
}

/** Suite names, for the `selfTest` command to offer when a filter matches nothing. */
export function suiteNames(): string[] {
  return libSuites.map((s) => s.name);
}

export {};

// What `runTests` reads back from a project's test page. Pure: the service does the
// I/O, this decides what the answer says. No signals, no @bundled/yaar.

/** The window a project's test page runs in, beside (never replacing) its preview. */
export function testWindowIdFor(projectId: string): string {
  // `devtools-preview-` first: app_eval only answers windows whose id starts with it.
  return `devtools-preview-${projectId}-tests`;
}

export interface TestReportFailure {
  name: string;
  file: string;
  error: string;
}

export interface TestReport {
  pass: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  files: Array<{ file: string; passed: number; failed: number; skipped: number }>;
  failures: TestReportFailure[];
  failuresOmitted?: number;
  loadErrors: Array<{ file: string; error: string }>;
  tests?: Array<{ name: string; file: string; status: string; durationMs: number }>;
}

/**
 * Decode what `app_eval` handed back for `__yaar_tests__.run()`.
 *
 * The eval reply is the iframe's serialized value, so an object can arrive as JSON
 * text, and a string as JSON-quoted text. Returns null for anything that is not a
 * report, so the caller can say so instead of reporting a pass it never saw.
 */
export function parseTestReport(raw: unknown): TestReport | null {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const counts = ['total', 'passed', 'failed', 'skipped'] as const;
  if (typeof r.pass !== 'boolean' || counts.some((k) => typeof r[k] !== 'number')) return null;
  return {
    ...(r as unknown as TestReport),
    files: Array.isArray(r.files) ? (r.files as TestReport['files']) : [],
    failures: Array.isArray(r.failures) ? (r.failures as TestReportFailure[]) : [],
    loadErrors: Array.isArray(r.loadErrors) ? (r.loadErrors as TestReport['loadErrors']) : [],
  };
}

/**
 * Shorten a failure's stack to the frames that are the project's own code.
 *
 * The test page is unminified, so frames name real functions — but every frame is
 * the page URL plus a line in one 100KB+ bundle, and the runner's own frames
 * (`assert`, the matcher, `withTimeout`, `__run`) say nothing about the failure. Keep the message and the
 * first few frames, with the long page URL cut to `test.html`.
 */
export function trimTestError(error: string, maxFrames = 4): string {
  const lines = error.split('\n');
  const frames = lines.filter((l) => /^\s+at /.test(l));
  const head = lines.filter((l) => !/^\s+at /.test(l));
  const kept = frames
    .filter((l) => !/\b(assert|withTimeout|__run|Object\.run)\b|<computed>/.test(l))
    .slice(0, maxFrames)
    .map((l) => l.replace(/[^\s(]*\/dist\/test\.html/g, 'test.html'));
  return [...head, ...kept].join('\n').trim();
}

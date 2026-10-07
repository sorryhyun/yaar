export {};
import { AppCommandError, errMsg, invoke, wait } from '@bundled/yaar';
import { compileTests as devCompileTests } from '@bundled/yaar-dev';
import { activeProject } from '../core';
import {
  parseTestReport,
  projectPath,
  relativizeProjectPaths,
  testWindowIdFor,
  trimTestError,
  type TestReport,
} from '../lib';
import { evaluateRaw } from './preview';

// `runTests`: build the project's src/**/*.test.ts into dist/test.html, run that page
// in a window of its own, and read the report back.
//
// A window of its own rather than the preview: re-pointing the preview at the test page
// would reset its inspect baseline, mark it stale and leave the user looking at a test
// harness where their app was. The test window opens minimized and is always closed
// again — which is also how a page wedged by a test that never returns gets stopped.

/** How long the page gets to load and register its tests before we give up. */
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 250;

/** Default budget for the run itself; the caller can raise it up to the eval ceiling. */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const MAX_TEST_TIMEOUT_MS = 170_000;

export interface RunTestsOptions {
  filter?: string;
  verbose?: boolean;
  timeoutMs?: number;
}

export type RunTestsResult =
  | (TestReport & { stage: 'run'; testFiles: string[] })
  | { pass: false; stage: 'compile' | 'load' | 'run'; testFiles: string[]; errors: string[] };

async function closeWindow(id: string): Promise<void> {
  try {
    await invoke(`yaar://windows/${id}`, { action: 'close' });
  } catch {
    /* not open — the normal case before a run */
  }
}

/** Wait until the page has loaded every test file, or say why it never did. */
async function waitForTestPage(wid: string): Promise<string | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const raw = await evaluateRaw(
        wid,
        "window.__yaar_tests__ ? window.__yaar_tests__.ready.then(() => 'ready') : 'loading'",
        READY_TIMEOUT_MS,
      );
      if (String(raw).includes('ready')) return null;
    } catch (err) {
      // The iframe may not be listening yet; keep polling until the deadline.
      lastError = errMsg(err);
    }
    await wait(READY_POLL_MS);
  }
  return (
    `The test page did not finish loading within ${READY_TIMEOUT_MS / 1000}s` +
    (lastError ? ` (last error: ${lastError})` : '') +
    '. A test file that blocks while it loads (a long synchronous loop at module scope) does this.'
  );
}

export async function runProjectTests(opts: RunTestsOptions = {}): Promise<RunTestsResult> {
  const proj = activeProject();
  if (!proj) throw new AppCommandError('No project open. openProject or createProject first.');

  const built = await devCompileTests(projectPath(proj.id), { title: proj.name });
  const testFiles = built.files ?? [];
  if (!built.success || !built.testUrl) {
    const errors = built.errors ?? [built.error ?? 'Test build failed'];
    return {
      pass: false,
      stage: 'compile',
      testFiles,
      errors: relativizeProjectPaths(errors, proj.id),
    };
  }

  const windowId = testWindowIdFor(proj.id);
  await closeWindow(windowId);
  const created = await invoke<{ windowId?: string }>(`yaar://windows/${windowId}`, {
    action: 'create',
    title: `${proj.name} (tests)`,
    renderer: 'iframe',
    content: built.testUrl,
    minimized: true,
    // The preview's principal: tests reach the same throwaway storage namespace the
    // preview does, never the deployed app's data.
    appId: `preview--${proj.id}`,
  });
  const wid = created?.windowId ?? windowId;

  try {
    const notReady = await waitForTestPage(wid);
    if (notReady) return { pass: false, stage: 'load', testFiles, errors: [notReady] };

    const timeoutMs = Math.min(
      Math.max(opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, 1_000),
      MAX_TEST_TIMEOUT_MS,
    );
    const args = JSON.stringify({ filter: opts.filter, verbose: opts.verbose === true });
    let raw: unknown;
    try {
      raw = await evaluateRaw(wid, `window.__yaar_tests__.run(${args})`, timeoutMs);
    } catch (err) {
      return {
        pass: false,
        stage: 'run',
        testFiles,
        errors: [
          `The run did not finish within ${timeoutMs}ms: ${errMsg(err)}. A per-test timeout ` +
            'cannot stop a synchronous loop (or a catastrophic regex); narrow it down with ' +
            '`filter`, or raise `timeoutMs` if the suite is just slow.',
        ],
      };
    }
    const report = parseTestReport(raw);
    if (!report) {
      return {
        pass: false,
        stage: 'run',
        testFiles,
        errors: [`The test page answered with something that is not a report: ${String(raw)}`],
      };
    }
    const tidy = (text: string) => relativizeProjectPaths([trimTestError(text)], proj.id)[0]!;
    return {
      ...report,
      stage: 'run',
      testFiles,
      failures: report.failures.map((f) => ({ ...f, error: tidy(f.error) })),
      loadErrors: report.loadErrors.map((e) => ({ ...e, error: tidy(e.error) })),
    };
  } finally {
    await closeWindow(wid);
  }
}

// Batch publish: the protocol `publish`, run over a list of apps one at a time in the
// background. Single-app publishing lives in publish.ts; this file is only the batch
// around it, and it holds that file's publish slot for the whole run so a `publish`
// command arriving mid-run answers `busy` instead of racing it.

import { createEffect, createRoot } from '@bundled/solid-js';
import {
  account,
  publishRun,
  setPublishRun,
  setSharedPublishRun,
  setStatus,
} from '../store/index.js';
import type { PublishResult, PublishRun, PublishRunEntry } from '../types.js';
import { refreshAccount } from './auth.js';
import {
  attemptPublish,
  claimPublishSlot,
  publishBusyReason,
  releasePublishSlot,
  resolvePublishApp,
} from './publish.js';
import { runAction } from './run-action.js';

export type PublishAllRequest = { appId: string; expectedVersion?: string };

export type PublishAllStart =
  | { started: true; total: number; poll: 'publishRun'; wait: 'waitPublish' }
  | { started: false; status: 'busy' | 'empty'; message: string };

export type PublishWait = PublishRun & { done: boolean; timedOut: boolean };

/** The one place `publishRun` changes — local and shared move together, always. */
function writeRun(run: PublishRun): void {
  setPublishRun(run);
  setSharedPublishRun(run);
}

function entryOf(r: PublishResult): PublishRunEntry {
  return {
    appId: r.appId,
    version: r.version ?? null,
    published: r.published,
    status: r.status,
    message: r.message,
    finishedAt: r.finishedAt,
  };
}

/** Answers every later app in the run would get too, so attempting them is pointless. */
function stopsRun(r: PublishResult): boolean {
  return r.status === 'terms_required' || (r.status === 'error' && !account().signedIn);
}

/**
 * Start publishing `apps` in order and return at once; the run reports through
 * `publishRun`. Refused while any protocol publish or the publish dialog is open.
 */
export function startPublishAll(apps: PublishAllRequest[]): PublishAllStart {
  if (apps.length === 0) {
    return { started: false, status: 'empty', message: 'No apps given to publish.' };
  }
  const busy = publishBusyReason();
  if (busy || !claimPublishSlot()) {
    return {
      started: false,
      status: 'busy',
      message: busy ?? 'Another publish is in progress in Market Apps — retry once it finishes.',
    };
  }
  // Raised before returning, so a waitPublish sent straight after this reply blocks.
  writeRun({
    active: true,
    total: apps.length,
    completed: 0,
    current: apps[0].appId.trim(),
    results: [],
    stopped: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
  void runPublishes(apps);
  return { started: true, total: apps.length, poll: 'publishRun', wait: 'waitPublish' };
}

/**
 * The run itself, entered only with the publish slot held. One app's refusal is
 * recorded and stepped over; only `stopsRun` answers end it, and the apps after that
 * are recorded as `skipped` so the caller can tell what never ran from what failed.
 */
async function runPublishes(apps: PublishAllRequest[]): Promise<void> {
  const total = apps.length;
  const startedAt = publishRun().startedAt;
  const results: PublishRunEntry[] = [];
  let stopped: PublishRun['stopped'] = null;
  const attempted = () => results.filter((r) => r.status !== 'skipped').length;

  await runAction(
    `Publishing ${total} apps…`,
    async () => {
      try {
        for (const [index, request] of apps.entries()) {
          const app = resolvePublishApp(request.appId);
          if (stopped) {
            results.push({
              appId: app.id,
              version: null,
              published: false,
              status: 'skipped',
              message: `Not attempted: the run stopped at ${stopped.appId} (${stopped.status}).`,
              finishedAt: new Date().toISOString(),
            });
            continue;
          }
          writeRun({
            active: true,
            total,
            completed: attempted(),
            current: app.id,
            results: [...results],
            stopped: null,
            startedAt,
            finishedAt: null,
          });
          setStatus(`Publishing ${app.name} (${index + 1}/${total})…`, false);

          const result = await attemptPublish(app, request.expectedVersion);
          results.push(entryOf(result));
          if (stopsRun(result)) {
            stopped = { appId: app.id, status: result.status, message: result.message };
          }
        }
      } finally {
        // Released before the final write, so a caller woken by `active: false` can
        // publish straight away instead of meeting a stale `busy`. In a finally so an
        // unexpected throw cannot leave the slot held for the life of the window.
        releasePublishSlot();
        writeRun({
          active: false,
          total,
          completed: attempted(),
          current: null,
          results: [...results],
          stopped,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
    },
    'Publish All failed',
  );

  const published = results.filter((r) => r.published);
  const failed = results.filter((r) => !r.published && r.status !== 'skipped');
  let summary = `Published ${published.length} of ${total} apps`;
  if (failed.length) {
    summary += ` — failed: ${failed.map((f) => `${f.appId} (${f.status})`).join(', ')}`;
  }
  if (stopped) summary += ` — stopped at ${stopped.appId}: ${stopped.message}`;
  setStatus(summary);
  if (published.length) void refreshAccount();
}

/**
 * Resolve with `publishRun` once no run is active, or after `timeoutMs`. Watches the
 * signal rather than the run's promise, so it answers in a copy of the window that is
 * only following another copy's run through the shared signal.
 */
export function waitForPublishRun(timeoutMs: number): Promise<PublishWait> {
  return new Promise((resolve) => {
    createRoot((dispose) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Deferred: the effect calling this is still running inside the root.
        queueMicrotask(dispose);
        const run = publishRun();
        resolve({ ...run, results: [...run.results], done: !run.active, timedOut });
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      createEffect(() => {
        if (!publishRun().active) finish(false);
      });
    });
  });
}

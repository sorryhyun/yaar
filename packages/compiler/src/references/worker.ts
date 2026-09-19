/**
 * Worker entry for `findReferences` — see `index.ts` for why it is a worker.
 *
 * Keeps a small LRU of warm `SandboxReferences`, keyed by sandbox and grants: a
 * follow-up query on the same app pays for the files that changed, not for a
 * fresh program. Two entries, because a program over a large app plus the DOM
 * lib is a few hundred megabytes and the usual caller works on one app at a time.
 */

import { loadTypeScript } from '../load-typescript.js';
import { readThreeRenderer } from '../bundled/three-renderer.js';
import { SandboxReferences } from './service.js';
import type { FindReferencesQuery, FindReferencesResult } from './types.js';

declare const self: Worker;

export interface WorkerRequest {
  id: number;
  root: string;
  bundles: string[];
  query: FindReferencesQuery;
}

export interface WorkerResponse {
  id: number;
  result: FindReferencesResult;
}

const MAX_WARM = 2;
const warm = new Map<string, SandboxReferences>();

async function serviceFor(root: string, bundles: string[]): Promise<SandboxReferences | null> {
  // app.json's `three` changes what `@bundled/three` declares, so it is part of
  // which program this is — flipping it must not hit the old service.
  const three = readThreeRenderer(root);
  const key = `${root}\0${[...bundles].sort().join(',')}\0${three}`;
  const hit = warm.get(key);
  if (hit) {
    // Re-insert so Map order is recency order.
    warm.delete(key);
    warm.set(key, hit);
    return hit;
  }
  const ts = await loadTypeScript();
  if (!ts) return null;
  const created = new SandboxReferences(ts, root, bundles, three);
  warm.set(key, created);
  while (warm.size > MAX_WARM) {
    const [oldestKey, oldest] = warm.entries().next().value!;
    warm.delete(oldestKey);
    oldest.dispose();
  }
  return created;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, root, bundles, query } = event.data;
  let result: FindReferencesResult;
  try {
    const service = await serviceFor(root, bundles);
    result = service
      ? service.find(query)
      : { success: false, kind: 'unavailable', error: 'TypeScript is not available in this build' };
  } catch (err) {
    result = {
      success: false,
      kind: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  self.postMessage({ id, result } satisfies WorkerResponse);
};

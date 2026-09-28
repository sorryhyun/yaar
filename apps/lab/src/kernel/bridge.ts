import { httpFetch } from '@bundled/yaar';
import { chartToPNG } from '../lib/chart-render';
import { graphToPNG } from '../lib/graph-render';
import { saveChart, saveGraph } from '../lib/shared-tree';
import {
  storeRead,
  storeWrite,
  storeList,
  storeRemove,
  storeExists,
  type WriteContent,
  type WriteEncoding,
} from './store-ops';
import type { ChartSpec, GraphSpec } from '../types';

/**
 * The one door the sandboxed worker has back into the app. Everything the kernel
 * cannot do itself (storage, http, Chart.js rendering) arrives here as a method
 * name plus args; nothing else is reachable from a cell.
 */

async function doFetch(url: string, init: RequestInit | null): Promise<unknown> {
  const res = await httpFetch(url, init || undefined);
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, ok: res.ok, headers, body };
}

/**
 * The cell's own `fetch`, performed here. A worker made from a `blob:` URL resolves
 * `/api/storage/...` against that URL and fails, and even an absolute URL would skip
 * what the window's fetch adds — the iframe token and the allowlisted proxy — so the
 * kernel replaces `self.fetch` with a call to this. The body comes back as bytes so a
 * cell can still read an image with `res.blob()`.
 */
async function doBinaryFetch(
  url: string,
  init: RequestInit | null,
): Promise<{ status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer }> {
  const res = await httpFetch(url, init || undefined);
  const headers: [string, string][] = [];
  res.headers.forEach((v, k) => headers.push([k, v]));
  return { status: res.status, statusText: res.statusText, headers, body: await res.arrayBuffer() };
}

/** Dispatch one bridge call coming from the worker. */
export async function handleBridgeCall(method: string, args: unknown[]): Promise<unknown> {
  const a = args || [];
  switch (method) {
    case 'store.read':
      return await storeRead(a[0] as string);
    case 'store.write':
      return await storeWrite(
        a[0] as string,
        a[1] as WriteContent,
        (a[2] as WriteEncoding | null) || undefined,
      );
    case 'store.list':
      return await storeList(a[0] as string);
    case 'store.remove':
      return await storeRemove(a[0] as string);
    case 'store.exists':
      return await storeExists(a[0] as string);
    case 'http.fetch':
      return await doFetch(a[0] as string, a[1] as RequestInit | null);
    case 'fetch':
      return await doBinaryFetch(a[0] as string, a[1] as RequestInit | null);
    case 'chart.png':
      return await chartToPNG(a[0] as ChartSpec, (a[1] as Record<string, number>) || undefined);
    case 'chart.save':
      return await saveChart(
        a[0] as ChartSpec,
        (a[1] as string) || undefined,
        (a[2] as Record<string, number>) || undefined,
      );
    case 'graph.png':
      return await graphToPNG(a[0] as GraphSpec, (a[1] as Record<string, number>) || undefined);
    case 'graph.save':
      return await saveGraph(
        a[0] as GraphSpec,
        (a[1] as string) || undefined,
        (a[2] as Record<string, number>) || undefined,
      );
    default:
      throw new Error('unknown bridge method: ' + method);
  }
}

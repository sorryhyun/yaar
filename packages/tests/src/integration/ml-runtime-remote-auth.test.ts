/**
 * REMOTE mode must not gate onnxruntime's own artifacts.
 *
 * `@bundled/yaar-ml` was unreachable in every installed build, and this gate is why.
 * `IS_REMOTE = process.env.REMOTE === '1' || IS_BUNDLED_EXE` — so a bundled exe is
 * *always* remote — and `isStaticAsset()` refuses everything under `/api/`, so
 * `/api/ml-runtime/*` demanded a token. onnxruntime fetches those artifacts itself
 * from `ort.env.wasm.wasmPaths` and has no hook to attach one, so the import 401'd
 * and the app rendered a blank window. The route had always *believed* it was open
 * ("they stay open — there is nothing behind them to protect"); nothing checked that
 * the gate above it agreed.
 *
 * **These tests run the gate in a REMOTE=1 subprocess, and that is the whole point.**
 * `IS_REMOTE` is captured at module load, so a test in this process — where REMOTE is
 * unset — gets `checkHttpAuth` returning null on its first line, and every assertion
 * passes no matter what the gate does. The neighbouring cases in `http-routing.test.ts`
 * are exactly that, and say so themselves ("IS_REMOTE is still false in test, so auth
 * is no-op"): they would not have caught this bug, and did not.
 *
 * `/api/apps` is asserted alongside for that reason — it is the canary. If it ever
 * comes back 200, REMOTE didn't take in the subprocess and these results mean nothing.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'path';

/** Ask the real `checkHttpAuth`, in a process where REMOTE=1 actually took effect. */
function probeUnderRemote(): Record<string, number> {
  const script = `
    const { checkHttpAuth, generateRemoteToken } = await import('@yaar/server/http/auth');
    generateRemoteToken();
    const probe = (p) => checkHttpAuth(new Request('http://x' + p), new URL('http://x' + p))?.status ?? 200;
    console.log(JSON.stringify({
      mlRuntimeLoader: probe('/api/ml-runtime/ort.webgpu.bundle.min.mjs'),
      mlRuntimeGlue: probe('/api/ml-runtime/ort-wasm-simd-threaded.asyncify.mjs'),
      mlRuntimeWasm: probe('/api/ml-runtime/ort-wasm-simd-threaded.asyncify.wasm'),
      apps: probe('/api/apps'),
      weights: probe('/api/ml-weights?url=https://host/model.onnx'),
      weightsDownload: probe('/api/ml-weights/download'),
    }));
  `;
  const proc = Bun.spawnSync(['bun', '-e', script], {
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env, REMOTE: '1' },
  });
  const out = proc.stdout.toString().trim();
  if (!proc.success) throw new Error(`probe failed: ${proc.stderr.toString()}`);
  return JSON.parse(out);
}

describe('REMOTE auth and /api/ml-runtime/', () => {
  const status = probeUnderRemote();

  it('has REMOTE genuinely in effect — otherwise nothing below means anything', () => {
    expect(status.apps).toBe(401);
  });

  it('serves the ORT artifacts without a token, since ORT cannot send one', () => {
    // All three: the module the app imports, and the glue + wasm that ORT itself
    // fetches from wasmPaths. The glue is what surfaced the bug — the loader was
    // cached (the route sets immutable, max-age=1y) so only the uncached file 401'd.
    expect(status.mlRuntimeLoader).toBe(200);
    expect(status.mlRuntimeGlue).toBe(200);
    expect(status.mlRuntimeWasm).toBe(200);
  });

  it('does not open the weight routes, which take a caller-named URL', () => {
    // The exemption is for inert, publicly-published artifacts under a fixed name
    // check. /api/ml-weights* proxies an arbitrary URL and streams it to disk — it
    // stays gated, on the remote token here and on the yaar-ml bundle in the route.
    expect(status.weights).toBe(401);
    expect(status.weightsDownload).toBe(401);
  });
});

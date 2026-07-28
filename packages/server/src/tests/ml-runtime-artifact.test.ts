/**
 * Where `/api/ml-runtime/` finds onnxruntime-web's artifacts.
 *
 * This exists because the answer was "nowhere" in every released build, and nothing
 * noticed. `getMlRuntimeDir()` pointed a bundled exe at an `ml-runtime/` directory
 * beside the executable that the build script never produced, the release never
 * uploaded, and the installer never fetched — so the route 404'd every request, ORT
 * failed to import, and the only symptom was a blank window in whatever app declared
 * `"bundles": ["yaar-ml"]`. Dev hid it: from a checkout the directory resolves to the
 * real `onnxruntime-web/dist`, so the feature worked on the machine of anyone who
 * would have tested it.
 *
 * A bundled exe now carries the artifacts inside itself, which is why resolution is
 * per *artifact* and not per *directory* — `/$bunfs/` paths don't share a parent worth
 * naming, and there is no directory to hand back.
 *
 * The real guard against a repeat is in `build/exe-bundle.js`, which now exits non-zero
 * rather than emitting a runtime-less binary. These tests pin the resolution order it
 * feeds.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'path';
import { getMlRuntimeArtifact, getMlRuntimeDir } from '../config.js';

const ORT_LOADER = 'ort.webgpu.bundle.min.mjs';
const EMBEDDED = { [ORT_LOADER]: '/$bunfs/root/ort.webgpu.bundle.min.mjs' };

function setEmbedded(map: Record<string, string> | undefined): void {
  if (map) (globalThis as Record<string, unknown>).__YAAR_ML_RUNTIME = map;
  else delete (globalThis as Record<string, unknown>).__YAAR_ML_RUNTIME;
}

afterEach(() => {
  setEmbedded(undefined);
  delete process.env.YAAR_ML_RUNTIME_DIR;
});

describe('getMlRuntimeArtifact', () => {
  it('serves the embedded copy when the exe carries one', () => {
    setEmbedded(EMBEDDED);
    expect(getMlRuntimeArtifact(ORT_LOADER)).toBe(EMBEDDED[ORT_LOADER]);
  });

  it('lets YAAR_ML_RUNTIME_DIR override the embedded copy', () => {
    // The point of the override is to run a newer/patched onnxruntime without a
    // rebuild — it has to beat the copy compiled into the binary, or it does nothing.
    setEmbedded(EMBEDDED);
    process.env.YAAR_ML_RUNTIME_DIR = '/opt/ort';
    expect(getMlRuntimeArtifact(ORT_LOADER)).toBe(join('/opt/ort', ORT_LOADER));
  });

  it('does not depend on whether the directory was resolved first', () => {
    // getMlRuntimeDir() memoizes. If the override were read through it, this call
    // would poison the cache and the override below would be silently ignored.
    getMlRuntimeDir();
    process.env.YAAR_ML_RUNTIME_DIR = '/opt/ort';
    expect(getMlRuntimeArtifact(ORT_LOADER)).toBe(join('/opt/ort', ORT_LOADER));
  });

  it('falls back to the resolved dist directory in dev', () => {
    // No embedded map and no override: a checkout resolves onnxruntime-web's dist,
    // which is what makes `make dev` work.
    const dir = getMlRuntimeDir();
    expect(dir).not.toBeNull();
    expect(getMlRuntimeArtifact(ORT_LOADER)).toBe(join(dir as string, ORT_LOADER));
  });

  it('resolves an artifact the map does not name through the directory', () => {
    // The map holds only the three artifacts the shim pins. A name outside it is not
    // a reason to refuse — the route's own guard decides that, and on disk the file
    // may well exist.
    setEmbedded(EMBEDDED);
    const other = 'ort-wasm-simd-threaded.asyncify.wasm';
    expect(getMlRuntimeArtifact(other)).toBe(join(getMlRuntimeDir() as string, other));
  });
});

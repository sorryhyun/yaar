// Pull the weight set from Hugging Face onto the server's disk (storage/anima/),
// so subsequent loads are local, offline-capable and survive a browser cache clear.
//
// The browser never touches the bytes: `POST /api/storage/{path}` buffers the whole
// body under MAX_UPLOAD_SIZE (50 MB) and the DiT sidecar alone is 3.9 GB. Instead
// `POST /api/ml-weights/download` has the *server* stream HF → disk, and we poll
// `GET /api/ml-weights/download?dest=…` for progress. Each file is resumable: a
// partial `.part` is continued with a Range request.
import { HF_BASE, LOCAL_DIR, resetAssetUrls } from './ml';
import { BUCKETS, SHARED_DIT_DATA, SHARED_VAE_DATA } from './buckets';

/** One DiT + VAE graph per aspect ratio. These are the ONLY per-ratio cost: the
 *  weights live in the two shared sidecars below, which every bucket's graph points
 *  at (share_sidecar.py). ~9.4 MB of graph buys a ratio; 3.9 GB of weights is paid
 *  once. Sizes are for the progress bar only. */
const BUCKET_GRAPHS = BUCKETS.flatMap((b) => [
  { path: `${b.dit}.onnx`, bytes: 9_400_000 },
  { path: `${b.vae}.onnx`, bytes: 560_000 },
]);

/** The minimum set `generate()` needs. Sizes are for the progress bar only. */
export const MANIFEST: { path: string; bytes: number }[] = [
  ...BUCKET_GRAPHS,
  // The weights, shared by every ratio.
  { path: SHARED_DIT_DATA, bytes: 3_913_271_296 },
  { path: SHARED_VAE_DATA, bytes: 56_053_056 },
  // text path (typed prompts)
  { path: 'text_encoder_fp16.onnx', bytes: 3_604_784 },
  { path: 'text_encoder_fp16.onnx.data', bytes: 1_192_421_376 },
  { path: 'text_conditioner_fp16.onnx', bytes: 1_570_420 },
  { path: 'text_conditioner_fp16.onnx.data', bytes: 269_389_824 },
  { path: 'webgpu/tokenizer/tokenizer.json', bytes: 11_422_924 },
  { path: 'webgpu/t5_tokenizer/tokenizer.json', bytes: 2_424_069 },
  // scheduler sigmas + per-channel denorm, and the golden-prompt embeds
  { path: 'webgpu/latent_stats.json', bytes: 434 },
  { path: 'webgpu/prompt_embeds.f32', bytes: 2_097_152 },
];

export const TOTAL_BYTES = MANIFEST.reduce((n, f) => n + f.bytes, 0);

interface JobStatus {
  state: 'idle' | 'downloading' | 'done' | 'error';
  loaded: number;
  total: number;
  error?: string;
}

export interface DownloadProgress {
  file: string;
  index: number;
  count: number;
  /** bytes of the current file */
  loaded: number;
  total: number;
  /** bytes across the whole manifest */
  overallLoaded: number;
  overallTotal: number;
}

const dest = (path: string) => `${LOCAL_DIR}/${path}`;

/** The weight routes are gated on this app's `yaar-ml` declaration; the token carries it. */
function authHeaders(): Record<string, string> {
  const token = (window as unknown as { __YAAR_TOKEN__?: string }).__YAAR_TOKEN__;
  return token ? { 'X-Iframe-Token': token } : {};
}

async function post(path: string): Promise<JobStatus> {
  const res = await fetch('/api/ml-weights/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ url: `${HF_BASE}/${path}`, dest: dest(path) }),
  });
  if (!res.ok) throw new Error(`start ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function poll(path: string): Promise<JobStatus> {
  const res = await fetch(`/api/ml-weights/download?dest=${encodeURIComponent(dest(path))}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`status ${path} → ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Download every manifest entry that isn't already on disk, one file at a time.
 *  Each file is itself fetched over parallel Range requests server-side, which
 *  already saturates the CDN edge — overlapping whole files on top of that only
 *  adds contention. */
export async function downloadWeights(onProgress?: (p: DownloadProgress) => void): Promise<void> {
  let done = 0;
  for (let i = 0; i < MANIFEST.length; i++) {
    const { path, bytes } = MANIFEST[i];
    const emit = (s: JobStatus) =>
      onProgress?.({
        file: path,
        index: i + 1,
        count: MANIFEST.length,
        loaded: s.loaded,
        total: s.total || bytes,
        overallLoaded: done + s.loaded,
        overallTotal: TOTAL_BYTES,
      });

    let status = await post(path);
    emit(status);
    while (status.state === 'downloading') {
      await sleep(500);
      status = await poll(path);
      emit(status);
    }
    if (status.state === 'error') throw new Error(`${path}: ${status.error ?? 'download failed'}`);
    done += status.loaded || bytes;
  }
  // Local copies now exist — drop the cached HF-proxy resolutions.
  resetAssetUrls();
}

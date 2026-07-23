/**
 * Where `POST /api/ml-weights/download` is allowed to write.
 *
 * The route streams an attacker-nameable URL to a caller-nameable path under
 * `storage/`. `requireBundle('yaar-ml')` says the caller may download weights; it
 * says nothing about *where*, so before this check any app declaring the bundle could
 * overwrite another app's storage — its credentials, its database, its sources.
 *
 * The fix names the destination in the permission model's own vocabulary and asks the
 * same gate `/api/storage/{path}` asks. That also buys `apps/self/` resolution, which
 * is the spelling the SDK's `prefetchWeights` uses and which the route could not
 * previously resolve at all (it would have created a literal `self` directory).
 */
import { describe, it, expect } from 'bun:test';
import { handleMlRuntimeRoutes } from '../http/routes/ml-runtime.js';
import { generateAppIframeToken, generateIframeToken } from '../http/iframe-tokens.js';

const HF = 'https://huggingface.co/org/repo/resolve/main/model.onnx';

/** The one bundled app declaring yaar-ml, until it was published standalone. */
const ML_APP = 'anima';

/**
 * A caller that has already cleared the bundle gate.
 *
 * `bundles` is never caller-supplied in production — `generateAppIframeToken`
 * reads it off the app's own app.json — so this test used to name a real app that
 * declared `yaar-ml`. When `anima` was published standalone and its source left
 * `apps/` (7e4f540), `getAppMeta` stopped resolving it, and every case here began
 * 403'ing at `requireBundle` instead of at the destination check it exists to
 * prove. Four of the six still *passed*, because a 403 is a 403.
 *
 * No bundled app declares `yaar-ml` today, so there is nothing to point at.
 * Stating the post-resolution principal directly keeps these tests aimed at
 * destination resolution and keeps them working whichever apps happen to ship —
 * the same thing `agent-stream-access.test.ts` does for `requireStream`. The
 * bundle gate itself is still covered end to end by the last case below, which
 * goes through the real app.json path.
 */
function mlAppToken(appId: string): string {
  return generateIframeToken(`win-${appId}`, 'sess-1', {
    appId,
    bundles: ['yaar-ml'],
    // Mirrors what a real yaar-ml app's token carries: its own storage is auto-granted.
    permissions: ['yaar://apps/self/storage/'],
  });
}

function post(token: string, body: unknown) {
  const req = new Request('http://localhost:8000/api/ml-weights/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-iframe-token': token },
    body: JSON.stringify(body),
  });
  return handleMlRuntimeRoutes(req, new URL(req.url));
}

function status(token: string, dest: string) {
  const req = new Request(
    `http://localhost:8000/api/ml-weights/download?dest=${encodeURIComponent(dest)}`,
    { headers: { 'x-iframe-token': token } },
  );
  return handleMlRuntimeRoutes(req, new URL(req.url));
}

describe('ml-weights download destination', () => {
  // Each refusal below names *why*, not just 403. A bare status assertion is what
  // let this file rot silently: when the app behind ML_APP stopped resolving, every
  // case started failing the bundle gate long before the destination check, and the
  // ones asserting only `403` went on passing for a reason they were not testing.
  it("refuses a write into another app's storage", async () => {
    const token = mlAppToken(ML_APP);
    const res = await post(token, { url: HF, dest: 'apps/notes/weights/model.onnx' });
    expect(res!.status).toBe(403);
    // The destination gate, in the permission model's own vocabulary — the URI it
    // refused is the one naming the *other* app's storage.
    expect(await res!.json()).toMatchObject({
      error: 'Not permitted: invoke yaar://apps/notes/storage/weights/model.onnx',
    });
  });

  it('refuses a traversing destination', async () => {
    const token = mlAppToken(ML_APP);
    const res = await post(token, { url: HF, dest: 'apps/self/../notes/x.onnx' });
    expect(res!.status).toBe(403);
    // Refused earlier than the grant check: a traversing path names no resource at
    // all, so there is no URI to match against permissions in the first place.
    expect(await res!.json()).toMatchObject({ error: 'Invalid path' });
  });

  it('refuses the write before asking the user about the domain', async () => {
    // Ordering, not just outcome: a dialog about "may this app reach huggingface?" for
    // a write that was never going to happen teaches people to click through prompts.
    // An unapproved domain would 403 too, so this asserts on the *absence* of a
    // pending prompt — the refusal must be immediate.
    const token = mlAppToken(ML_APP);
    const before = Date.now();
    const res = await post(token, { url: HF, dest: 'apps/notes/weights/model.onnx' });
    expect(res!.status).toBe(403);
    expect(await res!.json()).toMatchObject({ error: expect.stringContaining('Not permitted') });
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('accepts apps/self — the spelling prefetchWeights uses', async () => {
    // GET runs the same destination resolution with no download and no domain gate. A
    // 403 here would mean `self` was matched literally against the app's grants, which
    // would make the SDK's own destination unreachable.
    const token = mlAppToken(ML_APP);
    const res = await status(token, 'apps/self/weights/model.onnx');
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ state: 'idle' });
  });

  it('refuses a status probe for another app’s destination', async () => {
    // Progress is not nothing: it reveals which models another app has on disk.
    const token = mlAppToken(ML_APP);
    const res = await status(token, 'apps/notes/weights/model.onnx');
    expect(res!.status).toBe(403);
    // Same gate, same URI, and the same `invoke`: GET and POST share
    // `resolveWritableDest`, so a probe is checked as the write it is asking about
    // rather than as a read. Stricter than a read check, deliberately.
    expect(await res!.json()).toMatchObject({
      error: 'Not permitted: invoke yaar://apps/notes/storage/weights/model.onnx',
    });
  });

  it('still refuses an app that never declared yaar-ml', async () => {
    // The bundle gate is upstream of all of this and must not have been displaced.
    const token = await generateAppIframeToken('win-x', 'sess-1', {
      appId: 'memo',
      permissions: ['yaar://apps/self/storage/'],
    });
    const res = await post(token, { url: HF, dest: 'apps/self/weights/model.onnx' });
    expect(res!.status).toBe(403);
    expect(await res!.json()).toMatchObject({ error: expect.stringContaining('bundles') });
  });
});

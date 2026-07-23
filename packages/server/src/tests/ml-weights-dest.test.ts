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
import { generateAppIframeToken } from '../http/iframe-tokens.js';

const HF = 'https://huggingface.co/org/repo/resolve/main/model.onnx';

async function mlAppToken(appId: string): Promise<string> {
  return generateAppIframeToken(`win-${appId}`, 'sess-1', {
    appId,
    // Mirrors what a real yaar-ml app's token carries: its own storage is auto-granted.
    permissions: ['yaar://apps/self/storage/'],
  });
}

/** `bundles` comes off app.json, never the request — use an app that declares yaar-ml. */
const ML_APP = 'anima';

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
  it("refuses a write into another app's storage", async () => {
    const token = await mlAppToken(ML_APP);
    const res = await post(token, { url: HF, dest: 'apps/notes/weights/model.onnx' });
    expect(res!.status).toBe(403);
  });

  it('refuses a traversing destination', async () => {
    const token = await mlAppToken(ML_APP);
    const res = await post(token, { url: HF, dest: 'apps/self/../notes/x.onnx' });
    expect(res!.status).toBe(403);
  });

  it('refuses the write before asking the user about the domain', async () => {
    // Ordering, not just outcome: a dialog about "may this app reach huggingface?" for
    // a write that was never going to happen teaches people to click through prompts.
    // An unapproved domain would 403 too, so this asserts on the *absence* of a
    // pending prompt — the refusal must be immediate.
    const token = await mlAppToken(ML_APP);
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
    const token = await mlAppToken(ML_APP);
    const res = await status(token, 'apps/self/weights/model.onnx');
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ state: 'idle' });
  });

  it('refuses a status probe for another app’s destination', async () => {
    // Progress is not nothing: it reveals which models another app has on disk.
    const token = await mlAppToken(ML_APP);
    const res = await status(token, 'apps/notes/weights/model.onnx');
    expect(res!.status).toBe(403);
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

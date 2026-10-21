/**
 * `POST /api/dev/check-permissions` and `POST /api/dev/type-at`.
 *
 * check-permissions' one promise is that it answers the way the door does: the decision is
 * `permissionsAllow` over the project's own app.json, so `self`, the commons and a grant's
 * verb list come out exactly as a 403 would — and a malformed entry is reported, not
 * silently read as granted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { join, resolve } from 'path';

const { handleDevRoutes } = await import('../http/routes/dev.js');
const { generateAppIframeToken } = await import('../http/iframe-tokens.js');
const { getStorageDir } = await import('../config.js');
const { disposeReferencesWorker, initCompiler } = await import('@yaar/compiler');

const PROJECT = 'zz-check-permissions-route-fixture';
const projectDir = join(getStorageDir(), 'apps', 'devtools', 'projects', PROJECT);

beforeAll(async () => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await Bun.write(
    join(projectDir, 'app.json'),
    JSON.stringify({
      name: 'Fixture',
      appId: 'fixture',
      permissions: [
        'yaar://http',
        { uri: 'yaar://storage/files/', verbs: ['read', 'list'] },
        { uri: 'yaar://config/', verbs: 'read' },
      ],
    }),
  );
  await Bun.write(
    join(projectDir, 'src', 'main.ts'),
    'export function total(xs: number[]): number {\n  return xs.length;\n}\n',
  );
});

afterAll(async () => {
  disposeReferencesWorker();
  await rm(projectDir, { recursive: true, force: true });
});

async function post(action: string, body: Record<string, unknown>) {
  const token = await generateAppIframeToken('devtools', 'check-permissions-route-session', {
    appId: 'devtools',
    monitorId: '0',
  });
  const req = new Request(`http://localhost:8000/api/dev/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Iframe-Token': token },
    body: JSON.stringify({ path: `projects/${PROJECT}`, ...body }),
  });
  const res = await handleDevRoutes(req, new URL(req.url));
  return { status: res?.status, body: (await res!.json()) as Record<string, unknown> };
}

describe('POST /api/dev/check-permissions', () => {
  it('decides each use the way the door would', async () => {
    const { status, body } = await post('check-permissions', {
      uses: [
        { verb: 'invoke', uri: 'yaar://http' },
        { verb: 'read', uri: 'yaar://storage/files/notes.md' },
        { verb: 'delete', uri: 'yaar://storage/files/notes.md' },
        { verb: 'read', uri: 'yaar://apps/self/storage/state.json' },
        { verb: 'read', uri: 'yaar://storage/shared/fixture/x.json' },
        { verb: 'list', uri: 'yaar://windows/' },
        // The malformed `verbs` entry is dropped, so config is not granted.
        { verb: 'read', uri: 'yaar://config/settings' },
      ],
    });
    expect(status).toBe(200);
    expect(body.appId).toBe('fixture');
    expect((body.results as { allowed: boolean }[]).map((r) => r.allowed)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(String((body.problems as string[])[0])).toContain('yaar://config/');
  });

  it('marks a malformed use instead of guessing', async () => {
    const { body } = await post('check-permissions', {
      uses: [
        { verb: 'write', uri: 'yaar://http' },
        { verb: 'read', uri: 'https://example.com' },
      ],
    });
    const results = body.results as { error?: string }[];
    expect(results[0].error).toContain('verb must be one of');
    expect(results[1].error).toContain('yaar://');
  });

  it('refuses a body with no uses list', async () => {
    const { status } = await post('check-permissions', {});
    expect(status).toBe(400);
  });
});

describe('POST /api/dev/type-at', () => {
  // A cold references worker builds a whole TypeScript program first: ~2.5s alone, past
  // bun's 5s default when CI runs the other packages' suites alongside.
  it("answers the checker's hover text for a named symbol", async () => {
    const { status, body } = await post('type-at', { file: 'src/main.ts', symbol: 'total' });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      kind: 'function',
      type: 'function total(xs: number[]): number',
    });
  }, 20_000);
});

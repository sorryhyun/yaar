/**
 * `POST /api/dev/compile-tests` — a project's `*.test.ts` built into `dist/test.html`.
 *
 * The door's one promise beyond "it calls the compiler" is where the page lands: a
 * URL beside the app's `dist/index.html`, which deploy ships, and never that file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const { handleDevRoutes } = await import('../http/routes/dev.js');
const { generateAppIframeToken } = await import('../http/iframe-tokens.js');
const { getStorageDir } = await import('../config.js');

const PROJECT = 'zz-compile-tests-route-fixture';
const projectDir = join(getStorageDir(), 'apps', 'devtools', 'projects', PROJECT);

beforeAll(async () => {
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await Bun.write(join(projectDir, 'src', 'main.ts'), 'export const x = 1;\n');
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function post(): Promise<Record<string, unknown>> {
  const token = await generateAppIframeToken('devtools', 'compile-tests-route-session', {
    appId: 'devtools',
    monitorId: '0',
  });
  const req = new Request('http://localhost:8000/api/dev/compile-tests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Iframe-Token': token },
    body: JSON.stringify({ path: `projects/${PROJECT}` }),
  });
  const res = await handleDevRoutes(req, new URL(req.url));
  expect(res?.status).toBe(200);
  return (await res!.json()) as Record<string, unknown>;
}

describe('POST /api/dev/compile-tests', () => {
  it('reports a project with no test files as a failure', async () => {
    const body = await post();
    expect(body.success).toBe(false);
    expect(String((body.errors as string[])[0])).toContain('No test files found');
  });

  it('builds test.html beside index.html and returns its URL', async () => {
    await Bun.write(
      join(projectDir, 'src', 'x.test.ts'),
      "import { test, expect } from '@bundled/test';\ntest('x', () => expect(1).toBe(1));\n",
    );
    const body = await post();
    expect(body).toEqual({
      success: true,
      files: ['x.test.ts'],
      testUrl: `/api/storage/apps/devtools/projects/${PROJECT}/dist/test.html`,
    });
    expect(existsSync(join(projectDir, 'dist', 'test.html'))).toBe(true);
    expect(existsSync(join(projectDir, 'dist', 'index.html'))).toBe(false);
  });
});

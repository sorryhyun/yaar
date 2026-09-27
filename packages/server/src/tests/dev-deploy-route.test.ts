/**
 * `POST /api/dev/deploy` hands the caller everything the deploy says about its windows.
 *
 * `doDeploy` computed `staleWindow` for a self-deploy — the deploying window, spared and
 * still running the replaced bundle — and the route then rebuilt its response from four
 * named fields that did not include it. Devtools deployed itself, was told nothing, and
 * the next command it was sent failed against the old bundle's command list. The retire
 * logic is pinned by `deploy-retire-stale-app.test.ts`; this pins the door it goes out of.
 */
import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';

mock.module('../features/dev/deploy.js', () => ({
  doDeploy: async (_sandboxId: string, args: { appId: string }) => ({
    success: true,
    appId: args.appId,
    name: 'Dev Tools',
    icon: '🛠️',
    closedWindows: ['1/devtools'],
    staleWindow: '0/devtools',
  }),
}));

const { handleDevRoutes } = await import('../http/routes/dev.js');
const { generateAppIframeToken } = await import('../http/iframe-tokens.js');
const { getStorageDir } = await import('../config.js');

const PROJECT = 'zz-deploy-route-fixture';
const projectDir = join(getStorageDir(), 'apps', 'devtools', 'projects', PROJECT);

beforeAll(async () => {
  await mkdir(projectDir, { recursive: true });
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('POST /api/dev/deploy', () => {
  it('passes closedWindows and staleWindow through to the deploying iframe', async () => {
    const token = await generateAppIframeToken('devtools', 'deploy-route-session', {
      appId: 'devtools',
      monitorId: '0',
    });
    const req = new Request('http://localhost:8000/api/dev/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Iframe-Token': token },
      body: JSON.stringify({ path: `projects/${PROJECT}`, appId: 'devtools' }),
    });

    const res = await handleDevRoutes(req, new URL(req.url));
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({
      success: true,
      appId: 'devtools',
      name: 'Dev Tools',
      icon: '🛠️',
      closedWindows: ['1/devtools'],
      staleWindow: '0/devtools',
    });
  });
});

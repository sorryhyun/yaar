/**
 * `appOriginMarks` — the one statement of which app windows move to the isolated app
 * origin, and the `/api/iframe-token` mint that hands it to the desktop.
 *
 * The desktop opens an app from its icon by building the `window.create` itself, after
 * minting a token. That path used to carry no marks at all, so every installed app
 * opened from the desktop ran same-origin with it. The mint is where it now learns them.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { USER_APPS_DIR } from '../features/apps/roots.js';
import { appOriginMarks } from '../features/window/origin-marks.js';
import { installProxyPortBoundary, resetOriginBoundary } from '../http/origin-boundary.js';
import { handleApiRoutes } from '../http/routes/api.js';

/** An installed (`source:'user'`) app, present only for this file. */
const USER_APP = 'origin-marks-probe';
/** A bundled app from this checkout's `apps/`. */
const BUNDLED_APP = 'storage';

beforeAll(() => mkdirSync(join(USER_APPS_DIR, USER_APP), { recursive: true }));
afterAll(() => rmSync(join(USER_APPS_DIR, USER_APP), { recursive: true, force: true }));

afterEach(() => {
  resetOriginBoundary();
  delete process.env.YAAR_APP_ORIGIN_ISOLATION;
});

describe('appOriginMarks', () => {
  it('isolates an installed app, leaving the local app origin for the frontend to derive', () => {
    expect(appOriginMarks(USER_APP)).toEqual({ isolateOrigin: true });
  });

  it('leaves bundled apps, unknown ids and anonymous windows on the desktop origin', () => {
    expect(appOriginMarks(BUNDLED_APP)).toEqual({});
    expect(appOriginMarks('no-such-app')).toEqual({});
    expect(appOriginMarks(undefined)).toEqual({});
  });

  it('marks nothing when isolation is switched off', () => {
    process.env.YAAR_APP_ORIGIN_ISOLATION = '0';
    expect(appOriginMarks(USER_APP)).toEqual({});
  });

  it('states the app origin over a proxy-port boundary', () => {
    installProxyPortBoundary('https://box.ts.net', 'https://box.ts.net:8443');
    expect(appOriginMarks(USER_APP)).toEqual({
      isolateOrigin: true,
      appOrigin: 'https://box.ts.net:8443',
    });
  });
});

describe('/api/iframe-token', () => {
  async function mint(appId: string): Promise<Record<string, unknown>> {
    const req = new Request('http://localhost:8000/api/iframe-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowId: appId, sessionId: 'sess-1', appId, monitorId: '0' }),
    });
    const res = await handleApiRoutes(req, new URL(req.url));
    expect(res?.status).toBe(200);
    return (await res!.json()) as Record<string, unknown>;
  }

  it('hands the desktop the origin marks with the token', async () => {
    const body = await mint(USER_APP);
    expect(body.token).toBeString();
    expect(body.isolateOrigin).toBe(true);
  });

  it('marks nothing for a bundled app', async () => {
    const body = await mint(BUNDLED_APP);
    expect(body.token).toBeString();
    expect(body.isolateOrigin).toBeUndefined();
  });
});

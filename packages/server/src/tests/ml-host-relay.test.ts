/**
 * Remote ML compute (`features/ml-host/relay.ts`): who gets offloaded, who may open a
 * channel, and the one frame the server writes itself.
 *
 * The relay's happy path needs a real Chrome with a GPU, so it is verified by hand
 * (docs/installations/mac_ml.md has the numbers); what is here is the part that must not
 * drift silently. An `auto` that offloads Chromium clients buys a second tab and a
 * relay hop for nothing; a connect route that skips the bundle gate hands any app a
 * Chrome tab; a control frame in the wrong format is read by the shim as garbage, and a
 * decline stops meaning "compute here".
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  controlFrame,
  handleMlHostRoutes,
  mlComputeMode,
  wantsRemoteCompute,
} from '../features/ml-host/relay.js';
import { generateIframeToken } from '../http/iframe-tokens.js';

const ORIGINAL = process.env.YAAR_ML_COMPUTE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.YAAR_ML_COMPUTE;
  else process.env.YAAR_ML_COMPUTE = ORIGINAL;
});

describe('wantsRemoteCompute', () => {
  it('auto offloads WebKit on macOS only, and never a Chromium page', () => {
    delete process.env.YAAR_ML_COMPUTE;
    expect(mlComputeMode()).toBe('auto');
    expect(wantsRemoteCompute('webkit')).toBe(process.platform === 'darwin');
    expect(wantsRemoteCompute('chromium')).toBe(false);
    expect(wantsRemoteCompute(null)).toBe(false);
  });

  it('chrome forces every engine, local forbids every engine', () => {
    process.env.YAAR_ML_COMPUTE = 'chrome';
    expect(wantsRemoteCompute('chromium')).toBe(true);
    expect(wantsRemoteCompute('other')).toBe(true);
    process.env.YAAR_ML_COMPUTE = 'local';
    expect(wantsRemoteCompute('webkit')).toBe(false);
  });

  it('reads an unknown value as auto', () => {
    process.env.YAAR_ML_COMPUTE = 'gpu';
    expect(mlComputeMode()).toBe('auto');
  });
});

describe('handleMlHostRoutes', () => {
  // Never reached by the refusals below; an upgrade that got this far would be the bug.
  const server = {
    upgrade: () => {
      throw new Error('upgraded');
    },
  } as unknown as Parameters<typeof handleMlHostRoutes>[2];
  const call = (path: string) => {
    const url = new URL(`http://localhost:8000${path}`);
    return handleMlHostRoutes(new Request(url.href), url, server);
  };

  it('leaves other paths alone', () => {
    expect(call('/api/ml-hostile')).toBeNull();
  });

  it('refuses a connect with no iframe token', () => {
    const res = call('/api/ml-host/connect?engine=webkit');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a connect from an app that did not declare yaar-ml', () => {
    const token = generateIframeToken('win-notes', 'sess-1', { appId: 'notes' });
    const res = call(`/api/ml-host/connect?__yaar_token=${token}`);
    expect((res as Response).status).toBe(403);
  });

  it('upgrades a connect from a yaar-ml app', () => {
    const token = generateIframeToken('win-anima', 'sess-1', {
      appId: 'anima',
      bundles: ['yaar-ml'],
    });
    expect(() => call(`/api/ml-host/connect?__yaar_token=${token}`)).toThrow('upgraded');
  });

  it('refuses the host page and socket without a live channel secret', () => {
    expect((call('/api/ml-host/page?ch=nope') as Response).status).toBe(404);
    expect((call('/api/ml-host/ws?ch=nope') as Response).status).toBe(404);
    expect((call('/api/ml-host/page') as Response).status).toBe(404);
  });
});

describe('controlFrame', () => {
  it('is one final frame the shim can decode', () => {
    const f = controlFrame({ op: 'local', reason: 'no Chrome' });
    expect(f[0]).toBe(0); // no fragments follow
    const msg = f.subarray(1);
    const view = new DataView(msg.buffer, msg.byteOffset);
    const hlen = view.getUint32(0, true);
    expect(view.getUint32(4, true)).toBe(0);
    expect(msg.byteLength).toBe(8 + ((hlen + 7) & ~7));
    const header = JSON.parse(new TextDecoder().decode(msg.subarray(8, 8 + hlen)));
    expect(header).toEqual({ op: 'local', reason: 'no Chrome', b: [] });
  });
});

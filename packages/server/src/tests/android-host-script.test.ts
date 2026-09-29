/**
 * The Android APK's `window.yaarHost` adapter.
 *
 * The APK cannot import TypeScript, so it ships a generated copy of the desktop window's
 * adapter (`hosts/android/app/src/main/assets/yaar-host.js`). These tests make that copy
 * fail loudly when it drifts from the generator. They also run it against a fake
 * androidx.webkit channel, because the webMessage transport has no other exercise
 * off-device.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { YaarHost } from '@yaar/shared';
import { ANDROID_ORIGIN_PLACEHOLDER, androidHostScript } from '../desktop-window/host-bridge.js';

const ASSET = join(import.meta.dir, '../../../../hosts/android/app/src/main/assets/yaar-host.js');
const ORIGIN = 'http://localhost:8000';

type Sent = { id: number; op: string; args: Record<string, unknown> };

/** Run the asset the way the APK does: origin substituted, in a fake top frame. */
function load(opts: { origin?: string; top?: boolean } = {}) {
  const script = androidHostScript().replace(
    JSON.stringify(ANDROID_ORIGIN_PLACEHOLDER),
    JSON.stringify(ORIGIN),
  );
  const sent: Sent[] = [];
  const channel = new EventTarget() as EventTarget & { postMessage(data: string): void };
  channel.postMessage = (data: string) => sent.push(JSON.parse(data));
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.top = opts.top === false ? {} : win;
  win.__yaarHostInvoke = channel;
  new Function('window', 'location', script)(win, { origin: opts.origin ?? ORIGIN });
  const reply = (msg: unknown) =>
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
  return { host: win.yaarHost as YaarHost | undefined, win, sent, reply };
}

describe('android host script', () => {
  it('matches the checked-in asset (run scripts/codegen/android-host-script.ts)', () => {
    expect(readFileSync(ASSET, 'utf8')).toBe(androidHostScript());
  });

  it('defines nothing outside the top frame of the desktop origin', () => {
    expect(load({ top: false }).host).toBeUndefined();
    expect(load({ origin: 'http://127.0.0.1:8000' }).host).toBeUndefined();
  });

  it('round-trips an op by id, resolving and rejecting', async () => {
    const { host, sent, reply } = load();
    expect(host?.platform).toBe('android');

    const read = host!.clipboard.readText();
    const saved = host!.download({
      name: 'a.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([104, 105]).buffer,
    });
    await Promise.resolve();
    expect(sent.map((m) => m.op)).toEqual(['clipboard.readText', 'download']);
    expect(sent[1].args).toEqual({ name: 'a.txt', mime: 'text/plain', base64: 'aGk=' });

    // Out of order, and a reply to an id nobody is waiting on is ignored.
    reply({ id: 99, result: {} });
    reply({ id: sent[1].id, error: 'disk full' });
    reply({ id: sent[0].id, result: { text: 'clip' } });
    expect(await read).toBe('clip');
    await expect(saved).rejects.toThrow('disk full');
  });

  it('delivers pushed events through on()', () => {
    const { host, reply } = load();
    const got: unknown[] = [];
    const off = host!.on('back', (p) => got.push(p));
    reply({ event: 'back', payload: { n: 1 } });
    off();
    reply({ event: 'back', payload: { n: 2 } });
    expect(got).toEqual([{ n: 1 }]);
  });
});

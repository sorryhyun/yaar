import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { ensureSelfSignedCert } from '../tls/index.js';

const HAS_OPENSSL = Bun.spawnSync(['openssl', 'version'], {
  stdio: ['ignore', 'ignore', 'ignore'],
}).success;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaar-tls-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.if(HAS_OPENSSL)('mints once for localhost + 127.0.0.1, then reuses it', async () => {
  const a = await ensureSelfSignedCert(dir);
  const x = new X509Certificate(a!.cert);
  expect(x.checkHost('localhost')).toBe('localhost');
  expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1');
  expect((await ensureSelfSignedCert(dir))!.spki).toBe(a!.spki);
});

test('returns null when openssl is missing', async () => {
  expect(await ensureSelfSignedCert(dir, join(dir, 'no-such-openssl'))).toBeNull();
});

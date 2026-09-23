import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { ensureLocalCert } from '../tls/index.js';

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

test.if(HAS_OPENSSL)(
  'mints a CA-signed leaf for localhost + 127.0.0.1, then reuses it',
  async () => {
    const a = await ensureLocalCert(dir);
    const leaf = new X509Certificate(a!.cert);
    const ca = new X509Certificate(a!.ca);
    expect(leaf.checkHost('localhost')).toBe('localhost');
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(leaf.ca).toBe(false);
    expect(ca.ca).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    const b = await ensureLocalCert(dir);
    expect(b!.spki).toBe(a!.spki);
    expect(b!.ca).toBe(a!.ca);
  },
);

test.if(HAS_OPENSSL)('replaces a leaf the CA did not sign, keeping the CA', async () => {
  const a = await ensureLocalCert(dir);
  // A pre-CA directory: a self-signed cert.pem in place of the leaf.
  const other = mkdtempSync(join(tmpdir(), 'yaar-tls-other-'));
  const b = await ensureLocalCert(other);
  writeFileSync(join(dir, 'cert.pem'), b!.ca);
  writeFileSync(join(dir, 'key.pem'), readFileSync(join(other, 'ca-key.pem')));
  rmSync(other, { recursive: true, force: true });

  const c = await ensureLocalCert(dir);
  expect(c!.ca).toBe(a!.ca);
  expect(new X509Certificate(c!.cert).verify(new X509Certificate(a!.ca).publicKey)).toBe(true);
});

test('returns null when openssl is missing', async () => {
  expect(await ensureLocalCert(dir, join(dir, 'no-such-openssl'))).toBeNull();
});

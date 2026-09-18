/**
 * A self-signed certificate for a loopback HTTPS listener, kept in a directory the
 * caller names. Its purpose is HTTP/2: browsers speak h2 only over TLS.
 *
 * Trusted by a Chromium launched with `--ignore-certificate-errors-spki-list=<spki>`.
 * Minted once with `openssl` (neither Bun nor node can mint X.509) and reused after.
 */

import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SelfSignedCert {
  key: string;
  cert: string;
  /** base64(sha256(SPKI DER)) — Chromium's `--ignore-certificate-errors-spki-list` format. */
  spki: string;
}

/** base64(sha256(SPKI DER)) of a PEM certificate. */
export function spkiHash(certPem: string): string {
  const der = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

/**
 * The certificate in `dir`, minted for `localhost` + `127.0.0.1` if absent. `null` when
 * `openssl` could not mint one.
 */
export async function ensureSelfSignedCert(
  dir: string,
  openssl = 'openssl',
): Promise<SelfSignedCert | null> {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  if (!existsSync(certPath)) {
    mkdirSync(dir, { recursive: true });
    try {
      const proc = Bun.spawn(
        [
          openssl,
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '3650',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
      if ((await proc.exited) !== 0) return null;
    } catch {
      return null; // openssl not installed
    }
  }
  const cert = readFileSync(certPath, 'utf8');
  return { key: readFileSync(keyPath, 'utf8'), cert, spki: spkiHash(cert) };
}

/**
 * The certificate for a loopback HTTPS listener, kept in a directory the caller names.
 * Its first purpose was HTTP/2 (browsers speak h2 only over TLS); its second is a
 * secure context a browser we do not launch will accept.
 *
 * Two ways to trust it:
 *
 * - A Chromium launched with `--ignore-certificate-errors-spki-list=<spki>` pins the
 *   leaf's key and needs nothing installed.
 * - Any other browser trusts it through `ca.pem`, a local CA the user installs once.
 *   That is the only road on a phone running the server under Termux: the browser is
 *   the system's (Samsung Internet warns on every plain-http download, `localhost`
 *   included), and nothing can hand it a command-line flag.
 *
 * So the leaf is signed by that CA rather than by itself. The CA is minted once and
 * kept; the leaf is re-minted under it when it nears expiry, so an installed CA never
 * has to be installed again. Minted with `openssl` (neither Bun nor node can mint
 * X.509); `req -x509 -CA` needs OpenSSL 3.
 */

import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface LocalCert {
  key: string;
  cert: string;
  /** The local CA that signed `cert`, PEM — what a browser installs to trust it. */
  ca: string;
  /** base64(sha256(SPKI DER)) of the leaf — Chromium's `--ignore-certificate-errors-spki-list` format. */
  spki: string;
}

/** base64(sha256(SPKI DER)) of a PEM certificate. */
export function spkiHash(certPem: string): string {
  const der = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

const EC_KEY = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

/** Leaf lifetime. Kept at what publicly trusted roots may issue, in case a verifier checks. */
const LEAF_DAYS = 825;
/** Re-mint the leaf this long before it expires. */
const RENEW_MS = 30 * 24 * 60 * 60 * 1000;

async function run(argv: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(argv, { stdio: ['ignore', 'ignore', 'ignore'] });
    return (await proc.exited) === 0;
  } catch {
    return false; // openssl not installed
  }
}

/** Is the leaf at `certPath` one `ca` signed, and good for a while yet? */
function leafIsCurrent(certPath: string, ca: X509Certificate): boolean {
  if (!existsSync(certPath)) return false;
  try {
    const leaf = new X509Certificate(readFileSync(certPath, 'utf8'));
    return leaf.verify(ca.publicKey) && Date.parse(leaf.validTo) - Date.now() > RENEW_MS;
  } catch {
    return false;
  }
}

/**
 * The certificate in `dir` for `localhost` + `127.0.0.1`, minting the CA and the leaf
 * as needed. `null` when `openssl` could not mint them.
 *
 * A directory from before the CA existed holds a self-signed `cert.pem` and no
 * `ca.pem`; the leaf check fails against the new CA, so it is replaced.
 */
export async function ensureLocalCert(dir: string, openssl = 'openssl'): Promise<LocalCert | null> {
  const caKeyPath = join(dir, 'ca-key.pem');
  const caPath = join(dir, 'ca.pem');
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  mkdirSync(dir, { recursive: true });

  if (!existsSync(caPath) || !existsSync(caKeyPath)) {
    const minted = await run([
      openssl,
      'req',
      '-x509',
      ...EC_KEY,
      '-keyout',
      caKeyPath,
      '-out',
      caPath,
      '-days',
      '3650',
      '-subj',
      '/CN=YAAR Local CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    if (!minted) return null;
  }
  const ca = readFileSync(caPath, 'utf8');

  if (!leafIsCurrent(certPath, new X509Certificate(ca))) {
    rmSync(certPath, { force: true });
    const minted = await run([
      openssl,
      'req',
      '-x509',
      ...EC_KEY,
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      String(LEAF_DAYS),
      '-subj',
      '/CN=localhost',
      '-CA',
      caPath,
      '-CAkey',
      caKeyPath,
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'keyUsage=critical,digitalSignature',
      '-addext',
      'extendedKeyUsage=serverAuth',
    ]);
    if (!minted) return null;
  }

  const cert = readFileSync(certPath, 'utf8');
  return { key: readFileSync(keyPath, 'utf8'), cert, ca, spki: spkiHash(cert) };
}

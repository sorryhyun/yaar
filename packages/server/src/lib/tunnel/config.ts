/**
 * Load and validate tunnel configuration from config/tunnel.json.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getConfigDir } from '../../config.js';
import type { TunnelConfig } from './types.js';

export function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/** Keys only the removed SSH tunnel ever understood. */
const SSH_ONLY_KEYS = [
  'host',
  'username',
  'privateKeyPath',
  'password',
  'remotePort',
  'remoteHost',
  'publicHost',
  'publicHttps',
];

/**
 * Load tunnel config from config/tunnel.json.
 *
 * Returns null when the file is missing or says nothing usable — the caller then
 * falls back to the default transport (Tailscale Serve). There is no longer any way
 * to ask for *no* transport: remote mode is Tailscale Serve or nothing.
 *
 * A config left over from the SSH tunnel (`{ "service": "localhost.run" }`, or a
 * custom SSH server), or the removed `{ "disabled": true }`, is refused loudly rather
 * than silently honored: those requested a *public* or LAN URL, and quietly swapping in
 * a tailnet-only one — or quietly ignoring the file and doing the same — would be a
 * change of posture the user never asked for.
 */
export function loadTunnelConfig(): TunnelConfig | null {
  const configPath = join(getConfigDir(), 'tunnel.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return null; // File doesn't exist
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[Tunnel] Invalid JSON in config/tunnel.json');
    return null;
  }

  // Tunnel-off remote mode — removed. It bound 0.0.0.0 and published one host on one
  // port, which is the only shape that cannot carry the app-origin boundary, so a
  // hostile installed app could reach the desktop's DOM. Refused rather than ignored:
  // it asked for a LAN URL, and coming up tailnet-only without a word would be a
  // narrower posture than the user configured.
  if (parsed.disabled === true) {
    console.warn(
      '[Tunnel] config/tunnel.json asks to run with no tunnel ({ "disabled": true }), ' +
        'which YAAR no longer supports — using Tailscale Serve instead. That mode could ' +
        'not publish a second browser origin, so app-origin isolation was off in it. ' +
        'For a public URL, put an external tunnel in front of the tailnet address.',
    );
    return { service: 'tailscale' };
  }

  // Legacy SSH config — the transport is gone.
  const legacyKey = SSH_ONLY_KEYS.find((k) => k in parsed);
  if (parsed.service === 'localhost.run' || legacyKey) {
    console.warn(
      `[Tunnel] config/tunnel.json asks for the SSH tunnel (${
        parsed.service === 'localhost.run' ? 'service: "localhost.run"' : `"${legacyKey}"`
      }), which YAAR no longer supports — using Tailscale Serve instead. ` +
        'Replace it with { "service": "tailscale" }.',
    );
    return { service: 'tailscale' };
  }

  if (parsed.service !== undefined && parsed.service !== 'tailscale') {
    console.warn(
      `[Tunnel] Unknown service "${String(parsed.service)}" in config/tunnel.json — using Tailscale Serve.`,
    );
  }

  const config: TunnelConfig = { service: 'tailscale' };
  if (typeof parsed.tailscalePath === 'string') {
    config.tailscalePath = resolvePath(parsed.tailscalePath);
  }
  // The app-origin port must be a real port and must not collide with the desktop's
  // own :443 rule — same port means same origin, which is the one thing the second
  // rule exists to avoid.
  if (typeof parsed.appOriginPort === 'number') {
    const port = parsed.appOriginPort;
    if (Number.isInteger(port) && port > 0 && port < 65536 && port !== 443) {
      config.appOriginPort = port;
    } else {
      console.warn(
        `[Tunnel] Ignoring appOriginPort ${port}: must be an integer in 1–65535 and not 443`,
      );
    }
  }
  return config;
}

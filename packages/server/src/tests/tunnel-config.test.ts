/**
 * `config/tunnel.json` parsing.
 *
 * The part worth pinning is what happens to a config asking for something YAAR removed:
 * the SSH tunnel (`{ "service": "localhost.run" }` or a custom SSH server), or tunnel-off
 * remote mode (`{ "disabled": true }`). Each asked for a *public* or LAN URL; silently
 * honoring the file is impossible (neither transport exists) and silently ignoring it
 * would swap the user's posture without a word. So each warns and falls through to the
 * default, and the warning is the contract.
 *
 * Every path through this function now returns Tailscale or null. There is deliberately
 * no config that yields "no transport" — that was the last shape in which remote mode
 * ran without an app-origin boundary.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTunnelConfig } from '../lib/tunnel/config.js';
import type { TunnelConfig } from '../lib/tunnel/types.js';

/**
 * Point the config dir at `dir`, load, and put everything back.
 *
 * Every mutation and its restore sit in one synchronous block with no `await` between
 * them, so a concurrently-running test file can never observe the swapped env or the
 * stubbed `console.warn` — the unit suite shares a process.
 */
function loadFrom(dir: string): { config: TunnelConfig | null; warnings: string[] } {
  const prevConfig = process.env.YAAR_CONFIG;
  const prevWarn = console.warn;
  const warnings: string[] = [];
  process.env.YAAR_CONFIG = dir;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  try {
    return { config: loadTunnelConfig(), warnings };
  } finally {
    console.warn = prevWarn;
    if (prevConfig === undefined) delete process.env.YAAR_CONFIG;
    else process.env.YAAR_CONFIG = prevConfig;
  }
}

/** Run `fn` against a throwaway config dir holding `tunnel.json` (omit for no file). */
function withConfigDir<T>(contents: string | null, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'yaar-tunnel-'));
  try {
    if (contents !== null) writeFileSync(join(dir, 'tunnel.json'), contents);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadTunnelConfig', () => {
  test('no file → null, so the caller applies the default transport', () => {
    withConfigDir(null, (dir) => {
      expect(loadFrom(dir).config).toBeNull();
    });
  });

  test('invalid JSON → null with a warning, never a half-parsed config', () => {
    withConfigDir('{ not json', (dir) => {
      const { config, warnings } = loadFrom(dir);
      expect(config).toBeNull();
      expect(warnings.join('\n')).toContain('Invalid JSON');
    });
  });

  test('a request for no tunnel warns and falls back to Tailscale', () => {
    withConfigDir('{ "disabled": true }', (dir) => {
      const { config, warnings } = loadFrom(dir);
      // Tunnel-off remote mode bound 0.0.0.0 and published one host on one port — the
      // only shape that cannot carry the app-origin boundary. Refused, not ignored.
      expect(config).toEqual({ service: 'tailscale' });
      expect(warnings.join('\n')).toContain('disabled');
    });
  });

  test('tailscale config round-trips, tuning fields included', () => {
    withConfigDir('{ "service": "tailscale", "appOriginPort": 9443 }', (dir) => {
      expect(loadFrom(dir).config).toEqual({ service: 'tailscale', appOriginPort: 9443 });
    });
  });

  test('appOriginPort colliding with the desktop rule is dropped, not honored', () => {
    withConfigDir('{ "service": "tailscale", "appOriginPort": 443 }', (dir) => {
      const { config, warnings } = loadFrom(dir);
      // Same port means same origin — exactly what the second rule exists to avoid.
      expect(config).toEqual({ service: 'tailscale' });
      expect(warnings.join('\n')).toContain('appOriginPort');
    });
  });

  test('a leftover localhost.run config warns and falls back to Tailscale', () => {
    withConfigDir('{ "service": "localhost.run" }', (dir) => {
      const { config, warnings } = loadFrom(dir);
      expect(config).toEqual({ service: 'tailscale' });
      expect(warnings.join('\n')).toContain('localhost.run');
    });
  });

  test('a custom SSH server config warns and falls back to Tailscale', () => {
    withConfigDir('{ "host": "myserver.com", "username": "deploy" }', (dir) => {
      const { config, warnings } = loadFrom(dir);
      expect(config).toEqual({ service: 'tailscale' });
      // Naming the offending key is what makes the message actionable.
      expect(warnings.join('\n')).toContain('host');
    });
  });

  test('a disabled + legacy SSH config still lands on Tailscale, warning about the disable', () => {
    withConfigDir('{ "disabled": true, "host": "myserver.com" }', (dir) => {
      const { config, warnings } = loadFrom(dir);
      expect(config).toEqual({ service: 'tailscale' });
      // The disable is checked first, so that is the warning the user gets — it is the
      // one that explains why they aren't getting the LAN URL they configured.
      expect(warnings.join('\n')).toContain('disabled');
    });
  });

  test('an unknown service warns rather than booting an unasked-for transport silently', () => {
    withConfigDir('{ "service": "ngrok" }', (dir) => {
      const { config, warnings } = loadFrom(dir);
      expect(config).toEqual({ service: 'tailscale' });
      expect(warnings.join('\n')).toContain('ngrok');
    });
  });
});

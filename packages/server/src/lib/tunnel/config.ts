/**
 * Load and validate tunnel configuration from config/tunnel.json.
 */

import { readFileSync, existsSync } from 'fs';
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

/** Try to find an SSH key on the local machine. */
export function findSshKey(): Buffer | null {
  const candidates = [
    join(homedir(), '.ssh', 'id_ed25519'),
    join(homedir(), '.ssh', 'id_rsa'),
    join(homedir(), '.ssh', 'id_ecdsa'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p);
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Load tunnel config from config/tunnel.json.
 * Returns null if file is missing. Returns the parsed config otherwise.
 * For service mode (`{ "service": "localhost.run" }`), host/username are not required.
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

  // Explicit disable
  if (parsed.disabled === true) {
    return { disabled: true };
  }

  // Service mode — no host/username needed
  if (parsed.service === 'localhost.run') {
    return { service: 'localhost.run' };
  }

  // Custom SSH server — host and username required
  if (typeof parsed.host !== 'string' || !parsed.host) {
    console.warn('[Tunnel] config/tunnel.json missing required field: host');
    return null;
  }
  if (typeof parsed.username !== 'string' || !parsed.username) {
    console.warn('[Tunnel] config/tunnel.json missing required field: username');
    return null;
  }

  const config: TunnelConfig = {
    host: parsed.host,
    username: parsed.username,
  };

  if (typeof parsed.port === 'number') config.port = parsed.port;
  if (typeof parsed.password === 'string') config.password = parsed.password;
  if (typeof parsed.remotePort === 'number') config.remotePort = parsed.remotePort;
  if (typeof parsed.remoteHost === 'string') config.remoteHost = parsed.remoteHost;
  if (typeof parsed.publicHost === 'string') config.publicHost = parsed.publicHost;
  if (typeof parsed.publicHttps === 'boolean') config.publicHttps = parsed.publicHttps;

  if (typeof parsed.privateKeyPath === 'string') {
    config.privateKeyPath = resolvePath(parsed.privateKeyPath);
  }

  return config;
}

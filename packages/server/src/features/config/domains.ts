/**
 * Domain allowlist utilities for HTTP access control.
 *
 * Shared by http tools and sandbox fetch to enforce the same domain restrictions.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { configRead, configWrite, configStatMtime } from '../../storage/index.js';

const ALLOWED_DOMAINS_FILE = 'curl_allowed_domains.yaml';

// In-memory cache of the parsed allowlist. `isDomainAllowed` runs on every
// proxied httpFetch, and re-reading + YAML-parsing a tiny file each time is pure
// waste. We keep the parsed config in memory and re-read only when the file's
// mtime changes — so our own writes and external hand-edits both take effect,
// without paying the parse on the hot path.
let cache: { config: AllowedDomainsConfig; mtimeMs: number } | null = null;

interface AllowedDomainsConfig {
  allow_all_domains?: boolean;
  allowed_domains: string[];
}

/**
 * Extract domain (hostname) from a URL string.
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return '';
  }
}

/**
 * Read the full config from YAML storage.
 */
async function readConfig(): Promise<AllowedDomainsConfig> {
  // Serve from the in-memory cache when the file on disk hasn't changed.
  const mtimeMs = await configStatMtime(ALLOWED_DOMAINS_FILE);
  if (cache && mtimeMs !== null && cache.mtimeMs === mtimeMs) {
    return cache.config;
  }

  const result = await configRead(ALLOWED_DOMAINS_FILE);
  if (!result.success || !result.content) {
    const defaultConfig: AllowedDomainsConfig = { allowed_domains: [] };
    await configWrite(ALLOWED_DOMAINS_FILE, stringifyYaml(defaultConfig));
    cache = { config: defaultConfig, mtimeMs: (await configStatMtime(ALLOWED_DOMAINS_FILE)) ?? 0 };
    return defaultConfig;
  }

  let config: AllowedDomainsConfig;
  try {
    const parsed = parseYaml(result.content) as AllowedDomainsConfig;
    config = {
      allow_all_domains: parsed.allow_all_domains ?? false,
      allowed_domains: parsed.allowed_domains || [],
    };
  } catch {
    config = { allowed_domains: [] };
  }
  // Re-stat after the read: a concurrent write between our stat and read would
  // otherwise cache stale content against the newer mtime.
  cache = { config, mtimeMs: (await configStatMtime(ALLOWED_DOMAINS_FILE)) ?? mtimeMs ?? 0 };
  return config;
}

/**
 * Read allowed domains from config storage.
 */
export async function readAllowedDomains(): Promise<string[]> {
  const config = await readConfig();
  return config.allowed_domains;
}

/**
 * Check whether the "allow all domains" flag is enabled.
 */
export async function isAllDomainsAllowed(): Promise<boolean> {
  const config = await readConfig();
  return config.allow_all_domains === true;
}

/**
 * Set the "allow all domains" flag.
 */
export async function setAllowAllDomains(value: boolean): Promise<boolean> {
  const config = await readConfig();
  config.allow_all_domains = value;
  const result = await configWrite(ALLOWED_DOMAINS_FILE, stringifyYaml(config));
  cache = null; // force a re-read on next access (mtime may not have ticked)
  return result.success;
}

/**
 * Add a domain to the allowed list.
 */
export async function addAllowedDomain(domain: string): Promise<boolean> {
  const config = await readConfig();
  if (config.allowed_domains.includes(domain)) {
    return true;
  }

  config.allowed_domains.push(domain);
  const result = await configWrite(ALLOWED_DOMAINS_FILE, stringifyYaml(config));
  cache = null; // force a re-read on next access (mtime may not have ticked)
  return result.success;
}

/**
 * Check if a domain is in the allowed list (or all domains are allowed).
 */
export async function isDomainAllowed(domain: string): Promise<boolean> {
  const config = await readConfig();
  if (config.allow_all_domains) return true;
  return (config.allowed_domains || []).includes(domain);
}

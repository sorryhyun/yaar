/**
 * Domain allowlist utilities for HTTP access control.
 *
 * Shared by http tools and sandbox fetch to enforce the same domain restrictions.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { configRead, configWrite } from '../storage/index.js';

const ALLOWED_DOMAINS_FILE = 'curl_allowed_domains.yaml';

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
  const result = await configRead(ALLOWED_DOMAINS_FILE);
  if (!result.success || !result.content) {
    const defaultConfig: AllowedDomainsConfig = { allowed_domains: [] };
    await configWrite(ALLOWED_DOMAINS_FILE, stringifyYaml(defaultConfig));
    return defaultConfig;
  }

  try {
    const config = parseYaml(result.content) as AllowedDomainsConfig;
    return {
      allow_all_domains: config.allow_all_domains ?? false,
      allowed_domains: config.allowed_domains || [],
    };
  } catch {
    return { allowed_domains: [] };
  }
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

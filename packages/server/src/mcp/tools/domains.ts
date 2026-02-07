/**
 * Domain allowlist utilities for HTTP access control.
 *
 * Shared by http tools and sandbox fetch to enforce the same domain restrictions.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { configRead, configWrite } from '../../storage/index.js';

const ALLOWED_DOMAINS_FILE = 'curl_allowed_domains.yaml';

interface AllowedDomainsConfig {
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
 * Read allowed domains from config storage.
 */
export async function readAllowedDomains(): Promise<string[]> {
  const result = await configRead(ALLOWED_DOMAINS_FILE);
  if (!result.success || !result.content) {
    const defaultConfig: AllowedDomainsConfig = { allowed_domains: [] };
    await configWrite(ALLOWED_DOMAINS_FILE, stringifyYaml(defaultConfig));
    return [];
  }

  try {
    const config = parseYaml(result.content) as AllowedDomainsConfig;
    return config.allowed_domains || [];
  } catch {
    return [];
  }
}

/**
 * Add a domain to the allowed list.
 */
export async function addAllowedDomain(domain: string): Promise<boolean> {
  const domains = await readAllowedDomains();
  if (domains.includes(domain)) {
    return true;
  }

  domains.push(domain);
  const config: AllowedDomainsConfig = { allowed_domains: domains };
  const result = await configWrite(ALLOWED_DOMAINS_FILE, stringifyYaml(config));
  return result.success;
}

/**
 * Check if a domain is in the allowed list.
 */
export async function isDomainAllowed(domain: string): Promise<boolean> {
  const allowed = await readAllowedDomains();
  return allowed.includes(domain);
}

// Shape-tolerant readers for the two app lists.
//
// The catalog payload is schema-validated upstream (see schema.ts), but the host's
// `list('yaar://apps')` is not: it may answer with an array, a wrapper object under
// any of three keys, or a Markdown-ish text block. Everything here degrades to an
// empty list rather than throwing — a list we cannot read is reported as "unavailable"
// by the caller, never as "nothing is installed".

import type { ApiPayload, InstalledApp, ListedApp } from '../types.js';
import { firstString } from './ids.js';

export function parseMarket(payload: ApiPayload): ListedApp[] {
  return Array.isArray(payload.marketApps)
    ? payload.marketApps
    : Array.isArray(payload.apps)
      ? payload.apps
      : [];
}

function parseInstalledText(text: string): InstalledApp[] {
  if (!text) return [];
  const result: InstalledApp[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.+?)\s+\(([^)]+)\)/);
    if (m) result.push({ id: m[2].trim(), name: m[1].trim() });
  }
  return result;
}

function coerceInstalledApp(input: unknown): InstalledApp | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  let id = firstString(obj.id, obj.appId, obj.slug, obj.packageName);
  // resource_link format: extract id from uri (yaar://apps/{appId})
  if (!id && typeof obj.uri === 'string') {
    const m = obj.uri.match(/^yaar:\/\/apps\/([^/]+)/);
    if (m) id = m[1];
  }
  if (!id) return null;
  const name = firstString(obj.name, obj.title) ?? id;
  const kind = firstString(obj.kind);
  const version = firstString(obj.version);
  return { id, name, ...(kind ? { kind } : {}), ...(version ? { version } : {}) };
}

function parseInstalledList(items: unknown[]): InstalledApp[] {
  return items.map(coerceInstalledApp).filter((a): a is InstalledApp => a !== null);
}

export function parseInstalledAny(input: unknown): InstalledApp[] {
  if (Array.isArray(input)) return parseInstalledList(input);

  if (typeof input === 'string') return parseInstalledText(input);

  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const candidate = Array.isArray(obj.apps)
      ? obj.apps
      : Array.isArray(obj.installed)
        ? obj.installed
        : Array.isArray(obj.installedApps)
          ? obj.installedApps
          : [];

    if (candidate.length) {
      const parsed = parseInstalledList(candidate);
      if (parsed.length) return parsed;
    }

    if (typeof obj.text === 'string') return parseInstalledText(obj.text);
  }

  return [];
}

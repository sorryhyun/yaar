// ── Pure parsing / normalization helpers ─────────────────────────────────────
//
// No signals, no I/O — just data-in / data-out transforms over the shapes the
// marketplace and host verbs return. Kept pure so they can be reasoned about
// (and tested) in isolation from the reactive store.

import type { ApiPayload, InstalledApp, ListedApp } from './types.js';

export function normalizeDomain(input?: string | null): string {
  const value = (input || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

export function normalizeId(value: string): string {
  return (value || '').trim().toLowerCase();
}

export function sameAppId(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}

/** Returns the first truthy string among the given candidates, or null. */
export function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v) return v;
  return null;
}

export function parseMarket(payload: ApiPayload): ListedApp[] {
  return Array.isArray(payload.marketApps)
    ? payload.marketApps
    : Array.isArray(payload.apps)
      ? payload.apps
      : [];
}

export function parseInstalledText(text: string): InstalledApp[] {
  if (!text) return [];
  const result: InstalledApp[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.+?)\s+\(([^)]+)\)/);
    if (m) result.push({ id: m[2].trim(), name: m[1].trim() });
  }
  return result;
}

export function coerceInstalledApp(input: unknown): InstalledApp | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  let id = firstString(obj.id, obj.appId, obj.slug, obj.packageName);
  // resource_link format: extract id from uri (yaar://apps/{appId})
  if (!id && typeof obj.uri === 'string') {
    const m = (obj.uri as string).match(/^yaar:\/\/apps\/([^/]+)/);
    if (m) id = m[1];
  }
  if (!id) return null;
  const name = firstString(obj.name, obj.title) ?? id;
  const kind = firstString(obj.kind);
  return { id, name, ...(kind ? { kind } : {}) };
}

/** Map a raw array to valid InstalledApp entries, dropping nulls. */
export function parseInstalledList(items: unknown[]): InstalledApp[] {
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

// ── Pure parsing / normalization helpers ─────────────────────────────────────
//
// No signals, no I/O — just data-in / data-out transforms over the shapes the
// marketplace and host verbs return. Kept pure so they can be reasoned about
// (and tested) in isolation from the reactive store.

import { GITHUB_PUBLISH_COMPONENTS } from './constants.js';
import type { ApiPayload, GithubStatus, InstalledApp, ListedApp } from './types.js';

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
  const version = firstString(obj.version);
  return { id, name, ...(kind ? { kind } : {}), ...(version ? { version } : {}) };
}

/**
 * Numeric dot-parts of a semver core (ignoring any `-prerelease`/`+build` suffix),
 * or null for anything non-numeric. Mirrors the server's version guard so the
 * button's disabled state and the host's refusal agree.
 */
export function parseSemver(v: string): number[] | null {
  const core = v.trim().split('+')[0].split('-')[0];
  if (!core) return null;
  const nums = core.split('.').map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

/** Is `local` strictly newer than `published`? Unparseable versions never block (→ true). */
export function isNewerVersion(local: string, published: string): boolean {
  const a = parseSemver(local);
  const b = parseSemver(published);
  if (!a || !b) return true;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false; // equal → not newer
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

/**
 * Reduce a statuspage summary to the one question the banner asks: is anything
 * publishing needs unhealthy right now?
 *
 * Unknown/missing fields are treated as healthy. A status endpoint that changes
 * shape must not manufacture a scary banner about an outage that isn't happening.
 */
export function parseGithubStatus(payload: unknown): GithubStatus {
  const healthy: GithubStatus = {
    degraded: false,
    level: 'operational',
    components: [],
    incident: null,
  };
  if (!payload || typeof payload !== 'object') return healthy;
  const root = payload as { components?: unknown; incidents?: unknown };

  const components = Array.isArray(root.components) ? root.components : [];
  const watched = new Set(GITHUB_PUBLISH_COMPONENTS);
  const broken: string[] = [];
  let level = 'operational';

  for (const raw of components) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as { name?: unknown; status?: unknown };
    if (typeof c.name !== 'string' || !watched.has(c.name)) continue;
    if (typeof c.status !== 'string' || c.status === 'operational') continue;
    broken.push(c.name);
    // Keep the worst of the watched components — "partial_outage" reads very
    // differently from "degraded_performance" and the user deserves the real one.
    if (GITHUB_SEVERITY.indexOf(c.status) > GITHUB_SEVERITY.indexOf(level)) level = c.status;
  }

  if (!broken.length) return healthy;

  return {
    degraded: true,
    level,
    components: broken,
    incident: parseNewestIncident(root.incidents),
  };
}

/** The latest human-written update on the newest unresolved incident, if any. */
function parseNewestIncident(incidents: unknown): string | null {
  if (!Array.isArray(incidents)) return null;
  for (const raw of incidents) {
    if (!raw || typeof raw !== 'object') continue;
    const i = raw as { incident_updates?: unknown; name?: unknown };
    const updates = Array.isArray(i.incident_updates) ? i.incident_updates : [];
    for (const u of updates) {
      if (u && typeof u === 'object') {
        const body = (u as { body?: unknown }).body;
        if (typeof body === 'string' && body.trim()) return body.trim();
      }
    }
    if (typeof i.name === 'string' && i.name.trim()) return i.name.trim();
  }
  return null;
}

/** Statuspage severities, least to most severe — index order is the comparison. */
const GITHUB_SEVERITY = [
  'operational',
  'under_maintenance',
  'degraded_performance',
  'partial_outage',
  'major_outage',
];

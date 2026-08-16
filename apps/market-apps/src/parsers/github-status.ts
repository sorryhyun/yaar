// Reduce GitHub's statuspage summary to the single question the publish banner asks.

import { GITHUB_PUBLISH_COMPONENTS, GITHUB_SEVERITY, GITHUB_STATUS_HEALTHY } from '../constants.js';
import type { GithubStatus } from '../types.js';

/**
 * Reduce a statuspage summary to the one question the banner asks: is anything
 * publishing needs unhealthy right now?
 *
 * Unknown/missing fields are treated as healthy. A status endpoint that changes
 * shape must not manufacture a scary banner about an outage that isn't happening.
 */
export function parseGithubStatus(payload: unknown): GithubStatus {
  // A fresh copy per call: callers push this straight into a signal, and the
  // shared constant must never become someone's mutable state.
  const healthy: GithubStatus = { ...GITHUB_STATUS_HEALTHY };
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

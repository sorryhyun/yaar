export {};

// Reads the three verb-API lists this app renders and adapts them into the store.
//
// Each fetcher is the same three steps — list, validate, set — wrapped in the
// shared failure reporting below. Validation is per row: one unreadable entry
// costs that entry, never the list.

import { errMsg, list, showToast } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { LOG_PREFIX, URI } from './constants';
import {
  markRefreshed,
  setAgentStats,
  setInstalledApps,
  setWindows,
} from './store';
import {
  AgentEntrySchema,
  AgentStatsSchema,
  InstalledAppSchema,
  ResourceLinkSchema,
  WindowInfoSchema,
} from './schema';
import type { AgentEntry, AgentStats, AgentUsage, InstalledApp, WindowInfo } from './types';

// ── Failure reporting ────────────────────────────────────────────

/**
 * Names of the feeds currently in a failing state.
 *
 * These fetchers are driven by server-pushed change pings, not a poll, so on a
 * busy desktop they can run many times a second — a report per failure would be
 * a wall of toasts and a console filled at the same rate, which is how a console
 * stops being readable at exactly the moment someone needs to read it. So both
 * the toast and the log fire on the *transition* into a failing state, which is
 * the moment a user needs to know the panel has stopped telling the truth, and
 * again on recovery so the log says when it came back. `startWatching`'s
 * subscribe() failure reports once for the same reason.
 *
 * Per-row validation failures (see {@link logInvalidRow}) stay unconditional.
 * They carry the offending row, so collapsing them would cost the only
 * description of *what* was unreadable, and a roster with a permanently bad row
 * is a server bug worth being noisy about.
 */
const failing = new Set<string>();

function reportFetchFailure(what: string, err: unknown) {
  if (failing.has(what)) return;
  failing.add(what);
  console.error(`${LOG_PREFIX} fetching ${what} failed`, err);
  showToast(`Could not load ${what}: ${errMsg(err)}`, 'error');
}

function reportFetchOk(what: string) {
  if (!failing.delete(what)) return;
  // Only on the transition back — a success is the normal case and says nothing.
  console.info(`${LOG_PREFIX} fetching ${what} recovered`);
}

/** A row the schema could not read. Always logged, with the row itself. */
function logInvalidRow(kind: string, entry: unknown, issues: unknown) {
  console.error(`${LOG_PREFIX} ${kind} entry failed validation`, { entry, issues });
}

/**
 * Run one fetch under the shared reporting contract: success (including an early
 * return for an empty/absent list) clears the failing flag, a throw reports once
 * and hands control to `onFailure` to blank that list.
 */
async function guardedFetch(what: string, load: () => Promise<void>, onFailure: () => void) {
  try {
    await load();
    reportFetchOk(what);
  } catch (err) {
    reportFetchFailure(what, err);
    onFailure();
  }
}

// ── Shared adapters ─────────────────────────────────────────────

type ResourceLink = NonNullable<ReturnType<typeof asResourceLink>>;

/**
 * Adapt a resource_link list — `{ uri, name, description }` — into a flat record.
 * The verb layer returns links for `yaar://windows` and `yaar://apps` alike.
 *
 * Returns the validated link, or null when the entry is a direct record (it has
 * an `id`) or is not a link at all — the caller then tries the direct schema.
 */
function asResourceLink(entry: unknown) {
  const parsed = z.safeParse(ResourceLinkSchema, entry);
  return parsed.success ? parsed.data : null;
}

/**
 * The link-or-direct walk both `yaar://windows` and `yaar://apps` need: try the
 * resource_link shape first, fall back to the direct record, and skip (loudly)
 * anything neither adapter can read. Returning null from either adapter drops
 * the row.
 */
function adaptEntries<T>(
  entries: unknown[],
  fromLink: (link: ResourceLink) => T | null,
  fromDirect: (entry: unknown) => T | null,
): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    const link = asResourceLink(entry);
    const row = link ? fromLink(link) : fromDirect(entry);
    if (row) out.push(row);
  }
  return out;
}

/** The id a resource_link encodes in its URI, with the given root stripped off. */
function idFromUri(uri: string, root: string) {
  return uri.startsWith(`${root}/`) ? uri.slice(root.length + 1) : uri;
}

/**
 * Normalise a usage record off the wire. Every field is optional in the schema
 * (an older server may omit any of them), while {@link AgentUsage} requires the
 * two totals — defaulting them to 0 here is what keeps `inputRead()` out of NaN
 * territory and replaces the `as` cast this adapter used to carry.
 */
function toUsage(
  raw:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      }
    | undefined,
): AgentUsage | undefined {
  if (!raw) return undefined;
  return {
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    cacheReadTokens: raw.cacheReadTokens,
    cacheWriteTokens: raw.cacheWriteTokens,
  };
}

// ── Fetchers ───────────────────────────────────────────────────

export async function fetchAgents() {
  await guardedFetch(
    'agents',
    async () => {
      const raw = await list<unknown>(URI.agents);
      // A null/absent roster is a normal answer (no agents yet), not a failure.
      if (raw == null) return;

      const parsed = z.safeParse(AgentStatsSchema, raw);
      if (!parsed.success) {
        // Issues ride on the error rather than being logged here: this runs once
        // per change ping, and reportFetchFailure is the thing that knows whether
        // this failure has already been reported.
        throw new Error('Malformed agent roster', { cause: parsed.error.issues });
      }
      const d = parsed.data;

      // Rows are parsed individually: an agent the schema cannot read is dropped
      // and logged, while the rest of the roster — and the counters, which are
      // fine — still render.
      const agents: AgentEntry[] = [];
      for (const entry of d.agents ?? []) {
        const row = z.safeParse(AgentEntrySchema, entry);
        if (!row.success) {
          logInvalidRow('agent', entry, row.error.issues);
          continue;
        }
        const a = row.data;
        agents.push({
          id: a.id,
          type: a.type,
          label: a.label ?? a.id,
          busy: a.busy ?? false,
          monitorId: a.monitorId,
          appId: a.appId,
          usage: toUsage(a.usage),
        });
      }

      const stats: AgentStats = {
        totalAgents: d.totalAgents ?? 0,
        idleAgents: d.idleAgents ?? 0,
        busyAgents: d.busyAgents ?? 0,
        monitorAgents: d.monitorAgents ?? 0,
        appAgents: d.appAgents ?? 0,
        ephemeralAgents: d.ephemeralAgents ?? 0,
        sessionAgent: d.sessionAgent ?? false,
        usage: toUsage(d.usage),
        agents,
      };
      setAgentStats(stats);
    },
    () => setAgentStats(null),
  );
}

export async function fetchWindows() {
  await guardedFetch(
    'windows',
    async () => {
      const raw = await list<unknown[]>(URI.windows);
      if (!Array.isArray(raw)) {
        setWindows([]);
        return;
      }
      setWindows(
        adaptEntries<WindowInfo>(
          raw,
          (link) => {
            // The link's description is a comma-joined summary line:
            // "<renderer>, <size>[, locked][, app:<id>]".
            const parts = (link.description ?? '').split(', ');
            const appPart = parts.find((p) => p.startsWith('app:'));
            return {
              id: idFromUri(link.uri, URI.windows),
              uri: link.uri,
              title: link.name,
              renderer: parts[0] ?? '',
              size: parts[1] ?? '',
              position: '',
              locked: parts.includes('locked'),
              appId: appPart?.slice('app:'.length),
            };
          },
          (entry) => {
            const direct = z.safeParse(WindowInfoSchema, entry);
            if (!direct.success) {
              // One unreadable row must not blank the list — but it must not be
              // invisible either, or a renderer crash later is the first symptom.
              logInvalidRow('window', entry, direct.error.issues);
              return null;
            }
            const w = direct.data;
            return {
              id: w.id,
              uri: w.uri ?? `${URI.windows}/${w.id}`,
              title: w.title ?? w.id,
              position: w.position ?? '',
              size: w.size ?? '',
              renderer: w.renderer ?? '',
              locked: w.locked ?? false,
              lockedBy: w.lockedBy,
              appId: w.appId,
            };
          },
        ),
      );
    },
    () => setWindows([]),
  );
}

/**
 * The installed-app roster, for display names only — the running set comes from
 * windows and agents. Fetched once at mount: apps change on install/uninstall,
 * which is rare and doesn't push a change ping. An app installed mid-session just
 * shows its appId until the next refresh.
 */
export async function fetchApps() {
  await guardedFetch(
    'installed apps',
    async () => {
      const raw = await list<unknown[]>(URI.apps);
      if (!Array.isArray(raw)) {
        setInstalledApps([]);
        return;
      }
      setInstalledApps(
        adaptEntries<InstalledApp>(
          raw,
          (link) => ({
            id: idFromUri(link.uri, URI.apps),
            name: link.name,
            description: link.description,
          }),
          (entry) => {
            const direct = z.safeParse(InstalledAppSchema, entry);
            if (!direct.success) {
              logInvalidRow('app', entry, direct.error.issues);
              return null;
            }
            return {
              id: direct.data.id,
              name: direct.data.name ?? direct.data.id,
              description: direct.data.description,
            };
          },
        ),
      );
    },
    () => setInstalledApps([]),
  );
}

export async function refreshAll() {
  await Promise.all([fetchAgents(), fetchWindows(), fetchApps()]);
  markRefreshed();
}

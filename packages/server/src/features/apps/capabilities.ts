/**
 * What an app asks for, what it already holds, and how that is put to the user.
 *
 * Extracted from `install.ts` because the rules stopped being a formatting detail.
 * Two of the four capabilities here (`streams`, `subagents`) are **granted by the
 * install dialog and by nothing else** — `discovery.ts` reads the recorded answer back
 * as a ceiling — so the diff that decides whether to show that dialog is a security
 * boundary, and one worth testing without downloading a tarball first.
 */

import { join } from 'path';
import type { CapabilityLine } from '@yaar/shared';
import type { PermissionEntry } from '../../http/access.js';
import { parseSubAgents, type SubAgentsEntry } from './discovery.js';
import { resolveAppSource } from './roots.js';
import { readAppGrant, type AppGrant } from '../../storage/app-grants.js';

/**
 * What an installed app can hold that the user should get a say in.
 *
 * `controls` is deliberately absent: `discovery.ts` strips it for any app whose source
 * isn't `bundled`, so a marketplace app that declares it is granted nothing and asking
 * about it would describe authority it never gets. Everything else here is a real
 * grant — `permissions` and `bundles` because `getAppMeta` carries them onto the iframe
 * token regardless of source, and `streams`/`subagents` because this dialog is what
 * grants them. Both used to be stripped like `controls`, which left the apps built for
 * them unable to ask at all.
 */
export interface AppCapabilities {
  permissions: PermissionEntry[];
  bundles: string[];
  streams: string[];
  subagents?: SubAgentsEntry;
}

/** What each streamable source actually exposes, in the user's terms. */
const STREAM_DESCRIPTIONS: Record<string, string> = {
  agents: 'watch AI agents think and act, live, as they run',
};

/** What each gated SDK actually lets an app do, in the user's terms. */
const BUNDLE_DESCRIPTIONS: Record<string, string> = {
  'yaar-dev': 'compile, typecheck, and deploy apps on this machine',
  'yaar-web': 'drive a browser — navigate, click, and read pages',
  'yaar-ml': 'download and run machine-learning models in the browser',
};

interface PermissionDescription extends CapabilityLine {
  /** Prefix to match, with `{id}` standing for exactly one path segment. */
  match: string;
  /** Match only this exact URI, not everything under it. Outranks every prefix. */
  exact?: boolean;
}

/**
 * What each permission URI actually lets an app do, in the user's terms.
 *
 * Two rules make this a list rather than a lookup, and both exist because the broad
 * entries sit directly above the narrow ones:
 *
 * - **Longest prefix wins.** `yaar://apps/{id}/storage/` and `yaar://storage/media/` are
 *   narrow grants underneath two of the widest entries here; first-match-wins would
 *   describe an app that wants one private folder as one that wants everything.
 * - **An `exact` entry outranks every prefix.** `yaar://storage/` is the whole disk;
 *   `yaar://storage/notes/` is one folder. Prefix matching alone cannot tell them apart,
 *   so it would put "Full access to YAAR storage" on both — the direction of error this
 *   screen can least afford, since the user learns to ignore a warning that is always on.
 *
 * `warn` marks a grant that is *wide* rather than dangerous in itself — the storage root,
 * system settings, the app registry — so a whole-disk request reads differently from a
 * single-folder one without the reader parsing the URI.
 */
// One grant per line is the point here; reflowing to 100 columns hides the table.
// prettier-ignore
const PERMISSION_DESCRIPTIONS: readonly PermissionDescription[] = [
  { match: 'yaar://storage/',  exact: true, icon: '📁',  title: 'Read and write your files',            detail: 'Full access to YAAR storage', warn: true },
  { match: 'yaar://storage/',               icon: '📁',  title: 'Read and write files',                 detail: 'Limited to one folder in YAAR storage' },
  { match: 'yaar://storage/media/',         icon: '🖼️',  title: 'Share images and media with other apps' },
  { match: 'yaar://apps/',     exact: true, icon: '🧩',  title: 'See and manage installed apps',        warn: true },
  { match: 'yaar://apps/',                  icon: '🧩',  title: "Use another app's resources" },
  { match: 'yaar://apps/{id}/storage/',     icon: '📁',  title: 'Store its own data',                   detail: 'Private to this app' },
  { match: 'yaar://apps/{id}/db/',          icon: '🗄️',  title: 'Keep its own database',                detail: 'Private to this app' },
  { match: 'yaar://http',                   icon: '🌐',  title: 'Access the internet',                  detail: 'Requests to allowed domains' },
  { match: 'yaar://windows/',               icon: '🪟',  title: 'Open and control windows' },
  { match: 'yaar://user/notifications',     icon: '🔔',  title: 'Send you notifications' },
  { match: 'yaar://user/prompts',           icon: '❓',  title: 'Ask you questions' },
  { match: 'yaar://user/clipboard',         icon: '📋',  title: 'Read and write your clipboard' },
  { match: 'yaar://session',                icon: '🧠',  title: 'Read session info and memory' },
  { match: 'yaar://history/',               icon: '🕘',  title: 'Read past session logs' },
  { match: 'yaar://config/',   exact: true, icon: '⚙️',  title: 'Change system settings',               warn: true },
  { match: 'yaar://config/',                icon: '⚙️',  title: 'Change a system setting' },
  { match: 'yaar://config/mcp/',            icon: '🔌',  title: 'Manage external tool connections',     detail: 'MCP servers' },
  { match: 'yaar://mcp/',                   icon: '🔌',  title: 'Use connected external tools',         detail: 'MCP servers' },
  { match: 'yaar://skills/',                icon: '📘',  title: 'Read system skills' },
  { match: 'yaar://system/',                icon: '🖥️',  title: 'Read system status' },
  { match: 'yaar://system/update',          icon: '⬇️',  title: 'Check for and install YAAR updates',   warn: true },
];

/** A trailing slash is a spelling, not a grant: `yaar://http` and `yaar://http/` are one. */
function normalize(uri: string): string {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

/** `yaar://apps/{id}/storage/` → a regex accepting any single segment for `{id}`. */
function compile(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{id\\\}/g, '[^/]+');
  return new RegExp(`^${escaped}`);
}

const COMPILED = PERMISSION_DESCRIPTIONS.map((entry) => ({ entry, re: compile(entry.match) }));

/**
 * Say what one permission URI grants, or fall back to a sentence that at least admits
 * there is something here. Rendering nothing for an unrecognized URI would hide a grant
 * the user is about to make — the one failure mode this screen cannot have.
 */
export function describePermission(uri: string): CapabilityLine {
  const bare = normalize(uri);
  let best: PermissionDescription | undefined;
  for (const { entry, re } of COMPILED) {
    if (entry.exact) {
      // An exact hit is the last word — nothing narrower than the URI itself exists.
      if (normalize(entry.match) === bare) {
        best = entry;
        break;
      }
      continue;
    }
    if (re.test(uri) && (!best || entry.match.length > best.match.length)) best = entry;
  }
  if (!best) return { icon: '🔑', title: 'Use a YAAR resource', detail: uri, raw: uri };
  const { match: _match, exact: _exact, ...line } = best;
  return { ...line, raw: uri };
}

/**
 * The whole request as rows the install dialog lays out — every group in one flat list,
 * because the user is answering one question and four labelled sections asked it four
 * times. This replaced a pre-formatted string: a string can only be one weight, so the
 * raw URI could not be demoted and a broad grant could not be flagged.
 *
 * Gated SDKs are all flagged: they exist *because* they are privileged, and a row saying
 * "deploy apps on this machine" should not read like a row saying "send notifications".
 */
export function capabilityLines(caps: AppCapabilities): CapabilityLine[] {
  // The description tables are written as sentence fragments ("drive a browser") so they
  // can follow a name; as a row title they start the sentence.
  const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const lines: CapabilityLine[] = [];
  for (const p of caps.permissions) {
    const uri = typeof p === 'string' ? p : p.uri;
    const verbs = typeof p === 'string' ? undefined : p.verbs;
    const line = describePermission(uri);
    lines.push(verbs?.length ? { ...line, raw: `${uri} (${verbs.join(', ')})` } : line);
  }
  for (const b of caps.bundles) {
    lines.push({
      icon: '🛠️',
      title: BUNDLE_DESCRIPTIONS[b] ? sentence(BUNDLE_DESCRIPTIONS[b]) : `Use the ${b} SDK`,
      detail: 'Privileged SDK',
      raw: b,
      warn: true,
    });
  }
  for (const s of caps.streams) {
    lines.push({
      icon: '📡',
      title: STREAM_DESCRIPTIONS[s]
        ? sentence(STREAM_DESCRIPTIONS[s])
        : `Watch ${s} as they happen`,
      detail: 'Live activity',
      raw: s,
    });
  }
  if (caps.subagents) {
    const n = caps.subagents.max;
    lines.push({
      icon: '🤖',
      title: `Run up to ${n} AI ${n === 1 ? 'persona' : 'personas'} of its own`,
      detail: 'Each its own model session',
    });
  }
  return lines;
}

/** Stable identity for a permission entry, so two manifests can be compared. */
function permissionKey(p: PermissionEntry): string {
  if (typeof p === 'string') return p;
  return `${p.uri}|${(p.verbs ?? []).slice().sort().join(',')}`;
}

/**
 * Read the capabilities an app's app.json declares. Missing/invalid → none.
 *
 * `subagents` goes through `parseSubAgents` rather than being read raw, so the number in
 * the dialog is the number the app will actually get — the parser clamps to the per-app
 * ceiling, and a dialog that promised 40 while the grant was 16 would be a lie the user
 * could not detect.
 */
export async function readAppCapabilities(appDir: string): Promise<AppCapabilities> {
  const caps: AppCapabilities = { permissions: [], bundles: [], streams: [] };
  try {
    const metaContent = await Bun.file(join(appDir, 'app.json')).text();
    const meta = JSON.parse(metaContent);
    if (Array.isArray(meta.permissions)) caps.permissions = meta.permissions;
    if (Array.isArray(meta.bundles)) {
      caps.bundles = meta.bundles.filter((b: unknown): b is string => typeof b === 'string');
    }
    if (Array.isArray(meta.streams)) {
      caps.streams = meta.streams.filter((s: unknown): s is string => typeof s === 'string');
    }
    const subagents = parseSubAgents(meta);
    if (subagents) caps.subagents = subagents;
  } catch {
    // No app.json or invalid JSON
  }
  return caps;
}

/**
 * What the app already holds, which is what an update is diffed against.
 *
 * Deliberately not just the old manifest. For `permissions` and `bundles` the manifest
 * *is* the grant, so reading it back answers correctly. `streams` and `subagents` are
 * granted by the dialog and recorded separately — an app that has declared them
 * since before grants existed holds none of it, and diffing manifest-against-manifest
 * would call that "unchanged" and hand the capability over with no dialog at all.
 */
export async function heldCapabilities(appDir: string, appId: string): Promise<AppCapabilities> {
  const declared = await readAppCapabilities(appDir);
  // A bundled app is granted by shipping in the release; the grant file has no say.
  if (resolveAppSource(appId) === 'bundled') return declared;

  const grant = await readAppGrant(appId);
  return {
    permissions: declared.permissions,
    bundles: declared.bundles,
    streams: grant?.streams ?? [],
    ...(grant?.subagents ? { subagents: grant.subagents } : {}),
  };
}

/**
 * The capabilities in `next` that `previous` did not already hold.
 *
 * An update used to skip the dialog outright, so a v2 that newly asked for `yaar-web`
 * was granted it without the user ever seeing the request. Only the *added*
 * capabilities are prompted for — re-confirming what is already installed on every
 * routine update would train the user to click through.
 */
export function addedCapabilities(
  previous: AppCapabilities,
  next: AppCapabilities,
): AppCapabilities {
  const heldPermissions = new Set(previous.permissions.map(permissionKey));
  const heldBundles = new Set(previous.bundles);
  const heldStreams = new Set(previous.streams);
  // A raised ceiling is an ask; the same or a lower one is not.
  const ceilingGrew = next.subagents && next.subagents.max > (previous.subagents?.max ?? 0);
  return {
    permissions: next.permissions.filter((p) => !heldPermissions.has(permissionKey(p))),
    bundles: next.bundles.filter((b) => !heldBundles.has(b)),
    streams: next.streams.filter((s) => !heldStreams.has(s)),
    ...(ceilingGrew ? { subagents: next.subagents } : {}),
  };
}

/** Does this capability set contain anything at all worth asking about? */
export function isEmpty(caps: AppCapabilities): boolean {
  return (
    caps.permissions.length === 0 &&
    caps.bundles.length === 0 &&
    caps.streams.length === 0 &&
    !caps.subagents
  );
}

/**
 * The grant to record for a manifest the user accepted.
 *
 * Built from what was *requested*, not from the added-capabilities diff, so the file
 * always describes the whole of what the installed manifest holds — and an update that
 * drops a capability drops the grant with it.
 */
export function grantFor(requested: AppCapabilities): AppGrant {
  return {
    ...(requested.subagents ? { subagents: { max: requested.subagents.max } } : {}),
    ...(requested.streams.length > 0 ? { streams: requested.streams } : {}),
  };
}

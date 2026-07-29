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

/** Stable identity for a permission entry, so two manifests can be compared. */
function permissionKey(p: PermissionEntry): string {
  if (typeof p === 'string') return p;
  return `${p.uri}|${(p.verbs ?? []).slice().sort().join(',')}`;
}

/** Format capabilities into a human-readable string for the dialog. */
export function formatCapabilities(caps: AppCapabilities): string {
  const sections: string[] = [];
  if (caps.permissions.length > 0) {
    const lines = caps.permissions.map((p) => {
      if (typeof p === 'string') return `  • ${p}`;
      const verbs = p.verbs?.length ? ` (${p.verbs.join(', ')})` : '';
      return `  • ${p.uri}${verbs}`;
    });
    sections.push(`Access to:\n${lines.join('\n')}`);
  }
  if (caps.bundles.length > 0) {
    const lines = caps.bundles.map((b) => {
      const what = BUNDLE_DESCRIPTIONS[b];
      return what ? `  • ${b} — ${what}` : `  • ${b}`;
    });
    sections.push(`Privileged SDKs:\n${lines.join('\n')}`);
  }
  if (caps.streams.length > 0) {
    const lines = caps.streams.map((s) => {
      const what = STREAM_DESCRIPTIONS[s];
      return what ? `  • ${s} — ${what}` : `  • ${s}`;
    });
    sections.push(`Live activity:\n${lines.join('\n')}`);
  }
  if (caps.subagents) {
    const n = caps.subagents.max;
    sections.push(
      `Background AI:\n  • run up to ${n} AI ${n === 1 ? 'persona' : 'personas'} of its own, ` +
        'each its own model session',
    );
  }
  return sections.join('\n\n');
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

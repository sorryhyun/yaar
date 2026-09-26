/**
 * `app.json` — read once, normalised once.
 *
 * Every reader of an app's manifest used to parse the file itself and pick out the keys
 * it cared about, each with its own idea of what a malformed field meant. They drifted:
 * the install dialog read `permissions` raw while the token mint parsed it, so an entry
 * the mint would have dropped could crash the dialog's read and take the whole request
 * down with it. {@link normalizeManifest} is now the one reading of every key, and
 * {@link readManifest} the one read of the file.
 *
 * What this module does *not* do is decide what an app is entitled to. `kind: "system"`,
 * `controls`, cross-app storage, `streams` and `subagents` all depend on where the app
 * came from and what the user approved — that is `discovery.ts`, working from the
 * declared values here. Keeping the two apart is what lets this half stay pure.
 */

import { stat } from 'fs/promises';
import { join } from 'path';
// Type-only, and must stay so — see the note on the same import in `discovery.ts`.
import type { PermissionEntry } from '../../http/access.js';
import type { Verb } from '../../handlers/uri-registry.js';

export type WindowVariantType = 'standard' | 'widget' | 'panel';
export type DockEdgeType = 'top' | 'bottom';

/**
 * App criticality. `system` apps are core to the desktop: protected from
 * uninstall and auto-trusted (no permission prompt). Everything else is `app`.
 */
export type AppKind = 'system' | 'app';

/**
 * A single entry in an app's `controls` list — another app this app is allowed
 * to drive (describe/query/command with an `appId` param). Optionally restricted
 * to specific commands.
 */
export interface ControlEntry {
  appId: string;
  /** If set, only these commands may be issued to the target app. Omit = all commands. */
  commands?: string[];
  /**
   * Open this app minimized when control has to open it.
   *
   * For an app driven purely for what it computes — `lab` running a reduction over a
   * file the caller must never pull into its own context — a window arriving on top of
   * the user's work is noise, not feedback. The iframe still mounts and loads while
   * minimized, so the app is fully drivable; it just sits in the taskbar. Ignored when
   * the app already has a window: control never minimizes something the user opened.
   */
  minimized?: boolean;
}

/**
 * How many sub-agents an app may run per (monitor, app).
 *
 * `"subagents": { "max": N }`, and only that. `"personas"` was accepted as an alias
 * and no longer is — no app.json in the tree or on the market ever used it except
 * `chitchats`, and carrying two spellings for one field meant every doc that mentioned
 * it had to mention both. The *wire* keeps `personaId` (URI segment, spawn param,
 * response bodies): a character is what an app spawns, a sub-agent is what YAAR runs,
 * and only the manifest had to pick one word.
 */
export interface SubAgentsEntry {
  max: number;
}

/** Nobody gets a cast of thousands: a sub-agent is a provider process. */
const MAX_SUB_AGENTS_PER_APP = 16;

/**
 * Parse `subagents` from app.json. Returns undefined for an app that does not declare
 * it, or declares it with a nonsense `max` — "may not spawn any" is the answer for
 * every app that has not asked, which is nearly all of them.
 *
 * This is what the manifest *asks for*. For a non-bundled app it is not yet what the
 * app holds — see `applyGrant` in `discovery.ts`.
 *
 * Extra keys are ignored rather than rejected: the manifest is data on disk that
 * outlives any one YAAR build, so an app.json still carrying a field a past version
 * read should degrade to "the parts I understand" rather than to "cannot spawn".
 */
export function parseSubAgents(meta: { subagents?: unknown }): SubAgentsEntry | undefined {
  const raw = meta.subagents as { max?: unknown } | undefined;
  if (!raw || typeof raw !== 'object') return undefined;

  const max = Number(raw.max);
  if (!Number.isInteger(max) || max <= 0) return undefined;

  return { max: Math.min(max, MAX_SUB_AGENTS_PER_APP) };
}

/**
 * Does this manifest still use the retired `personas` spelling?
 *
 * Dropping an accepted key turns a working app into a silently inert one, and the app
 * that hits this is `chitchats` — published at v1.1.1 declaring `personas`, so every
 * install of it stops spawning until it is republished. That failure has to be
 * *legible*: this is what lets the refusal say "rename it" instead of "add it", which
 * is the same trap the bundled-only gate used to set.
 */
export function usesRetiredPersonasKey(meta: { subagents?: unknown; personas?: unknown }): boolean {
  return !parseSubAgents(meta) && !!meta.personas && typeof meta.personas === 'object';
}

/** Parse permission entries from app.json, supporting both string and object formats. */
function parsePermissions(raw: unknown[]): PermissionEntry[] {
  const result: PermissionEntry[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      result.push(entry);
    } else if (
      entry &&
      typeof entry === 'object' &&
      'uri' in entry &&
      typeof (entry as { uri: unknown }).uri === 'string'
    ) {
      const obj = entry as { uri: string; verbs?: unknown };
      const parsed: PermissionEntry = { uri: obj.uri };
      if (Array.isArray(obj.verbs) && obj.verbs.every((v) => typeof v === 'string')) {
        parsed.verbs = obj.verbs as Verb[];
      }
      result.push(parsed);
    }
  }
  return result;
}

/** Parse `controls` from app.json, supporting string shorthand and object form. */
function parseControls(raw: unknown[]): ControlEntry[] {
  const result: ControlEntry[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      result.push({ appId: entry });
    } else if (
      entry &&
      typeof entry === 'object' &&
      'appId' in entry &&
      typeof (entry as { appId: unknown }).appId === 'string'
    ) {
      const obj = entry as { appId: string; commands?: unknown; minimized?: unknown };
      const parsed: ControlEntry = { appId: obj.appId };
      if (Array.isArray(obj.commands) && obj.commands.every((c) => typeof c === 'string')) {
        parsed.commands = obj.commands as string[];
      }
      if (obj.minimized === true) parsed.minimized = true;
      result.push(parsed);
    }
  }
  return result;
}

function strings(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : undefined;
}

function string(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * An app.json as *declared* — every key typed, nothing yet gated on the app's source.
 *
 * A key the file omits, or spells with the wrong type, is absent here; a list key that
 * is present but holds some malformed entries keeps the well-formed ones. That is the
 * same "degrade to the parts I understand" rule {@link parseSubAgents} states, applied
 * to every key instead of re-decided per reader.
 */
export interface AppJson {
  /**
   * The parsed file as written, for the one kind of caller that carries keys through
   * rather than reading them (deploy merges it into the manifest it writes). Shared by
   * every reader of a cached manifest — never mutate it.
   */
  raw: Readonly<Record<string, unknown>>;
  /** The id the app registers under, which `defineApp({ id })` must equal. */
  appId?: string;
  name?: string;
  /** Absent when empty, like every display string below it. */
  description?: string;
  /** Emoji. An `icon.*` image beside the manifest wins over it — see `discovery.ts`. */
  icon?: string;
  version?: string;
  author?: string;
  /** False when the file says `createShortcut: false`, or the legacy `hidden: true`. */
  createShortcut: boolean;
  run?: string;
  /** Declared only. `discovery.ts` refuses `system` to anything not bundled. */
  kind: AppKind;
  variant?: WindowVariantType;
  dockEdge?: DockEdgeType;
  frameless: boolean;
  windowStyle?: Record<string, string | number>;
  defaultWidth?: number;
  defaultHeight?: number;
  messaging?: 'all';
  agentType?: string;
  /** Declared; `discovery.ts` caps an installed app's reach into other apps' storage. */
  permissions?: PermissionEntry[];
  /** Declared; honoured for bundled apps only. */
  controls?: ControlEntry[];
  /** Gated `@bundled/yaar-*` SDKs (`yaar-dev`, `yaar-web`, `yaar-ml`, …). */
  bundles?: string[];
  /** Declared; an installed app holds only what the user granted at install. */
  streams?: string[];
  /** Declared; an installed app holds only what the user granted at install. */
  subagents?: SubAgentsEntry;
  /** See {@link usesRetiredPersonasKey}. */
  usesRetiredPersonasKey: boolean;
}

/**
 * Type every key of a parsed app.json. Pure; `null` for anything that is not a JSON
 * object, which every caller already treated as "no manifest".
 */
export function normalizeManifest(raw: unknown): AppJson | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const meta = raw as Record<string, unknown>;

  const variant = meta.variant === 'widget' || meta.variant === 'panel' ? meta.variant : undefined;
  const dockEdge =
    meta.dockEdge === 'top' || meta.dockEdge === 'bottom' ? meta.dockEdge : undefined;
  const subagents = parseSubAgents(meta);

  return {
    raw: meta,
    appId: string(meta.appId) || undefined,
    name: string(meta.name),
    description: string(meta.description) || undefined,
    icon: string(meta.icon) || undefined,
    version: string(meta.version),
    author: string(meta.author),
    createShortcut: !(meta.createShortcut === false || meta.hidden === true),
    run: string(meta.run),
    kind: meta.kind === 'system' ? 'system' : 'app',
    ...(variant && { variant }),
    ...(dockEdge && { dockEdge }),
    frameless: meta.frameless === true,
    ...(meta.windowStyle && typeof meta.windowStyle === 'object'
      ? { windowStyle: meta.windowStyle as Record<string, string | number> }
      : {}),
    ...(typeof meta.defaultWidth === 'number' && { defaultWidth: meta.defaultWidth }),
    ...(typeof meta.defaultHeight === 'number' && { defaultHeight: meta.defaultHeight }),
    ...(meta.messaging === 'all' && { messaging: 'all' as const }),
    agentType: string(meta.agentType),
    ...(Array.isArray(meta.permissions) && { permissions: parsePermissions(meta.permissions) }),
    ...(Array.isArray(meta.controls) && { controls: parseControls(meta.controls) }),
    bundles: strings(meta.bundles),
    streams: strings(meta.streams),
    ...(subagents && { subagents }),
    usesRetiredPersonasKey: usesRetiredPersonasKey(meta),
  };
}

/**
 * Read and normalise `dir/app.json` straight off disk; `null` if it is absent or is not
 * a JSON object.
 *
 * Uncached, for directories that are not installed apps — a devtools sandbox, an install
 * staging directory. Those are rewritten under the same path by design (staging is one
 * directory per app id, reused by every install), so a cache there could only be wrong.
 */
export async function readManifestFile(dir: string): Promise<AppJson | null> {
  try {
    return normalizeManifest(JSON.parse(await Bun.file(join(dir, 'app.json')).text()));
  } catch {
    return null;
  }
}

/**
 * Parsed manifests of installed apps, by app directory.
 *
 * `getAppMeta` alone reads the manifest several times per app window (the create, the
 * token mint, every app-agent storage and messaging check), and nothing between those
 * reads changes the file. Each entry carries the file's identity at read time and is
 * re-read when that moves, so a manifest edited by hand in a checkout is seen on the
 * next read without anyone having to invalidate it. The explicit
 * {@link invalidateManifest} is for the writers YAAR knows about (`notifyAppChanged`),
 * and drops the entry of an app that is gone.
 */
const manifests = new Map<string, { stamp: string; manifest: AppJson | null; settled: boolean }>();

/**
 * How recently a file may have been written and still have its stamp trusted.
 *
 * The kernel stamps mtime from a coarse clock (a few milliseconds on Linux, two seconds
 * on FAT), so two same-size writes inside one tick leave identical stamps over different
 * content. A file last written that recently is re-read rather than trusted — git's
 * "racily clean" rule. It only costs reads while the file is still being written.
 */
const RACY_WINDOW_MS = 2_000;

/**
 * The normalised app.json of an installed app directory, cached. `null` if absent or
 * not a JSON object. The result is shared — see {@link AppJson.raw}.
 */
export async function readManifest(dir: string): Promise<AppJson | null> {
  let stamp: string;
  let settled: boolean;
  try {
    const s = await stat(join(dir, 'app.json'), { bigint: true });
    stamp = `${s.ino}:${s.size}:${s.mtimeNs}`;
    settled = Date.now() - Number(s.mtimeMs) > RACY_WINDOW_MS;
  } catch {
    manifests.delete(dir);
    return null;
  }
  const hit = manifests.get(dir);
  if (hit?.settled && hit.stamp === stamp) return hit.manifest;
  // Stamped before the read, so a write landing between the two leaves a stale stamp
  // against fresh content — which only costs the next caller one more read.
  const manifest = await readManifestFile(dir);
  manifests.set(dir, { stamp, manifest, settled });
  return manifest;
}

/** Forget the cached manifest for one app directory. */
export function invalidateManifest(dir: string): void {
  manifests.delete(dir);
}

export {};

/**
 * Reads and version arithmetic over a project's app.json text — the pure half of
 * `deploy`'s version rule and of the toolbar's Deploy button.
 */

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface VersionBump {
  /** The version before the bump, or null when app.json had none. */
  from: string | null;
  to: string;
  /** True when `from` was missing or not semver, so the count restarted at 0.0.1. */
  restarted: boolean;
}

/**
 * One patch step: 1.2.3 → 1.2.4. A prerelease or build suffix is dropped rather than
 * carried, since the bumped number is a new release. Anything that is not semver
 * restarts at 0.0.1 and says so, instead of guessing what the author meant.
 */
export function bumpPatch(version: unknown): VersionBump {
  const from = typeof version === 'string' ? version : version == null ? null : String(version);
  const match = typeof version === 'string' ? SEMVER.exec(version.trim()) : null;
  if (!match) return { from, to: '0.0.1', restarted: true };
  return { from, to: `${match[1]}.${match[2]}.${Number(match[3]) + 1}`, restarted: false };
}

interface Semver {
  core: [number, number, number];
  pre: string | null;
}

function parseSemver(version: unknown): Semver | null {
  const match = typeof version === 'string' ? SEMVER.exec(version.trim()) : null;
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

/**
 * Semver precedence, negative when `a` sorts first. Build metadata is ignored and a
 * prerelease sorts below its release; two prereleases compare as plain strings, which
 * is coarser than the spec and only matters between prereleases of one release.
 */
function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    const d = a.core[i]! - b.core[i]!;
    if (d !== 0) return d;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export interface DeployBump {
  from: string | null;
  to: string;
  /** Why the version moved, in words for the agent and the user. */
  reason: string;
  /** Present only when no semver version existed anywhere, so the count restarted at 0.0.1. */
  restarted?: true;
}

/**
 * The version a deploy should ship as, given the project's app.json `version` and the
 * installed app's. A deploy must never ship the same or a lower version over an
 * installed one, or the marketplace cannot tell the new build from the old.
 *
 * - `bump: false` — deploy as written, never bump.
 * - `bump: true` — always one patch step, above the higher of project and installed.
 * - omitted — keep a project version strictly above the installed one (an author's
 *   hand-set 2.0.0 survives); otherwise one patch step above the higher of the two.
 *   Nothing installed, or an installed version that is not semver, leaves it alone.
 */
export function planDeployVersion(
  project: string | null,
  installed: string | null,
  bump?: boolean,
): { version: string | null; bumped?: DeployBump } {
  if (bump === false) return { version: project };
  const p = parseSemver(project);
  const i = parseSemver(installed);
  const installedHigher = i !== null && (p === null || compareSemver(i, p) > 0);
  const base = installedHigher ? installed : p ? project : null;

  if (bump === true) {
    if (base === null) {
      return {
        version: '0.0.1',
        bumped: {
          from: project,
          to: '0.0.1',
          reason: 'bump: true, and no semver version to continue from — restarted at 0.0.1',
          restarted: true,
        },
      };
    }
    const to = bumpPatch(base).to;
    const reason = installedHigher
      ? `bump: true, continuing from installed ${installed} (project had ${project ?? 'none'})`
      : 'bump: true';
    return { version: to, bumped: { from: project, to, reason } };
  }

  if (i === null || (p !== null && compareSemver(p, i) > 0)) return { version: project };
  const to = bumpPatch(base).to;
  const reason =
    p === null
      ? `project has no semver version and ${installed} is installed`
      : compareSemver(p, i) === 0
        ? `project version ${project} is already installed`
        : `project version ${project} is below installed ${installed}`;
  return { version: to, bumped: { from: project, to, reason } };
}

/**
 * The version out of a `read('yaar://apps/{appId}')` answer, which arrives either bare
 * or wrapped in `{ content }` depending on the door. Null for anything without one.
 */
export function installedVersionOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.version === 'string') return record.version;
  return record.content !== undefined ? installedVersionOf(record.content) : null;
}

function parseManifest(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `app.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('app.json is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** app.json text with `version` set, keeping key order and a trailing newline. */
export function withAppJsonVersion(text: string, version: string): string {
  const manifest = parseManifest(text);
  manifest.version = version;
  const trailing = text.endsWith('\n') ? '\n' : '';
  return JSON.stringify(manifest, null, 2) + trailing;
}

/** A string field of app.json, or null when the text is absent, unparseable, or lacks it. */
export function manifestString(text: string | null, key: string): string | null {
  if (text === null) return null;
  try {
    const value = parseManifest(text)[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

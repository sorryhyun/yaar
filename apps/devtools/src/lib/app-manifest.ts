export {};

/**
 * Reads and version arithmetic over a project's app.json text — the pure half of
 * `deploy({ bump: true })` and of the toolbar's Deploy button.
 */

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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

/** app.json text with `version` bumped one patch step, keeping key order and a trailing newline. */
export function bumpAppJson(text: string): VersionBump & { text: string } {
  const manifest = parseManifest(text);
  const bump = bumpPatch(manifest.version);
  manifest.version = bump.to;
  const trailing = text.endsWith('\n') ? '\n' : '';
  return { ...bump, text: JSON.stringify(manifest, null, 2) + trailing };
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

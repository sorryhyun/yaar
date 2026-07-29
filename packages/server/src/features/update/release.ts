/**
 * The GitHub release a self-update reads from: which release is latest, which
 * asset this machine needs, and what `SHA256SUMS` says those assets should hash to.
 *
 * Everything here is pure or takes an injected `fetch`, so the updater's decisions
 * are testable without a network. The side effects (downloading, hashing, swapping
 * files on disk) live in `installer.ts`.
 *
 * **Why this does not go through `performFetch`.** The proxied fetch exists to gate
 * URLs an *app or agent* chose, against the user's domain allowlist. Every URL here
 * is built from `RELEASE_REPO` plus a release tag GitHub itself just handed us, so
 * there is no attacker-chosen host to gate — and routing it through the allowlist
 * would make checking for updates pop a "allow api.github.com?" dialog. The 10 MB
 * response cap in `performFetch` would also reject the binary outright.
 */

import { isNewer, normalizeVersion } from './semver.js';

/** The repository releases are published from. Matches install.sh / install.ps1. */
export const RELEASE_REPO = 'sorryhyun/yaar';

/** Platform-independent archive of `apps/`, extracted next to the binary. */
export const APPS_ASSET = 'yaar-apps.tar.gz';

/** Checksum manifest published by release.yml alongside the artifacts. */
export const SUMS_ASSET = 'SHA256SUMS';

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

export interface ReleaseInfo {
  /** Tag as published, e.g. `v0.4.1`. */
  tag: string;
  /** Tag with the leading `v` stripped — the spelling `/api/version` reports. */
  version: string;
  name: string;
  notes: string;
  htmlUrl: string;
  publishedAt: string | null;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

/**
 * Name of the binary asset for a platform/arch pair, or null when the release
 * publishes no build for it.
 *
 * The five names are release.yml's, not a guess from a user agent: windows-x64,
 * linux-x64, linux-arm64, macos-x64, macos-arm64. Windows on arm64 has no build,
 * and saying so beats downloading an x64 binary that will not run.
 */
export function assetNameFor(platform: string, arch: string): string | null {
  const os =
    platform === 'darwin'
      ? 'macos'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : null;
  if (!os) return null;

  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!cpu) return null;
  if (os === 'windows' && cpu !== 'x64') return null;

  return os === 'windows' ? `yaar-${os}-${cpu}.exe` : `yaar-${os}-${cpu}`;
}

/**
 * Parse a `sha256sum`-format manifest into `name → lowercase hex hash`.
 *
 * Each line is `<hash>  <name>`, where the name may carry a `*` binary marker.
 * Unparsable lines are skipped rather than failing the whole manifest — a future
 * release that adds a header or a blank line must not make an install unverifiable.
 */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) out.set(match[2], match[1].toLowerCase());
  }
  return out;
}

/** Absolute download URL for one asset of a release tag. */
export function assetUrl(tag: string, name: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${name}`;
}

type FetchLike = typeof fetch;

interface GithubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>;
}

/**
 * Fetch the repository's latest published release.
 *
 * `/releases/latest` excludes drafts and prereleases by GitHub's own definition,
 * which is what we want: an update offered to every user should be the one the
 * install script would hand a new one.
 */
export async function fetchLatestRelease(fetchImpl: FetchLike = fetch): Promise<ReleaseInfo> {
  const res = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'yaar-updater',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    // 403 here is nearly always the unauthenticated rate limit (60/hr per IP), and
    // "GitHub said 403" sends people looking for a permissions problem they do not have.
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub rate-limited the update check. Try again in a few minutes.');
    }
    throw new Error(`GitHub returned ${res.status} ${res.statusText} for the latest release.`);
  }

  const body = (await res.json()) as GithubRelease;
  const tag = body.tag_name;
  if (!tag) throw new Error('GitHub returned a release with no tag_name.');

  return {
    tag,
    version: normalizeVersion(tag),
    name: body.name || tag,
    notes: body.body || '',
    htmlUrl: body.html_url || `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`,
    publishedAt: body.published_at || null,
    prerelease: body.prerelease === true,
    assets: (body.assets ?? []).flatMap((a) =>
      a.name && a.browser_download_url
        ? [{ name: a.name, size: a.size ?? 0, downloadUrl: a.browser_download_url }]
        : [],
    ),
  };
}

/** Whether a release supersedes the running version. */
export function releaseIsNewer(release: ReleaseInfo, currentVersion: string): boolean {
  return isNewer(release.version, currentVersion);
}

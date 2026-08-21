/**
 * Updater tests.
 *
 * Every seam is an injected `fetch` rather than a `mock.module` — still the right shape
 * now that `--isolate` has made a stub harmless to its neighbours, because an injected
 * seam is what lets one *case* choose a different response from the next.
 *
 * The install path itself (download → verify → swap) is deliberately not exercised
 * here — it replaces `process.execPath`, which under `bun test` is the test runner's
 * own binary. What *is* covered is everything that decides whether it runs at all,
 * plus the checksum-manifest parsing the verification depends on.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { compareVersions, isNewer, normalizeVersion, parseVersion } from './semver.js';
import { assetNameFor, fetchLatestRelease, parseSums, releaseIsNewer } from './release.js';
import {
  checkForUpdate,
  getUpdateStatus,
  resetUpdateStateForTest,
  setUpdateFetchForTest,
  startInstall,
  UpdateRefused,
} from './updater.js';

afterEach(() => resetUpdateStateForTest());

/**
 * Wrap a handler as a `fetch`.
 *
 * Bun's `fetch` type carries a `preconnect` member, so a bare arrow function does not
 * structurally match it and every call site would otherwise need its own double cast.
 */
function stubFetch(handler: (url: string) => Promise<Response>): typeof fetch {
  return ((input: unknown) => handler(String(input))) as unknown as typeof fetch;
}

// ── semver ──────────────────────────────────────────────────────────────

describe('parseVersion', () => {
  test('accepts a bare and a v-prefixed version', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  test('splits prerelease identifiers and drops build metadata', () => {
    expect(parseVersion('1.0.0-rc.2+build.5')?.prerelease).toEqual(['rc', '2']);
  });

  test('rejects what is not a version', () => {
    for (const bad of ['', 'latest', '1.2', '1.2.3.4', 'v1.x.0']) {
      expect(parseVersion(bad)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  test('orders by major, minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  test('a prerelease sorts below its release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBeLessThan(0);
    // Numeric identifiers rank below alphanumeric ones, per semver §11.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    // A shorter run of identifiers is lower precedence when the shared prefix is equal.
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBeLessThan(0);
  });

  test('an unparsable version sorts below a parsable one', () => {
    expect(compareVersions('garbage', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('garbage', 'nonsense')).toBe(0);
  });
});

describe('isNewer', () => {
  test('compares across the v prefix', () => {
    expect(isNewer('v0.4.0', '0.3.9')).toBe(true);
    expect(isNewer('0.3.9', 'v0.4.0')).toBe(false);
  });

  test('every real release supersedes the 0.0.0-unknown fallback', () => {
    // resolveVersion() returns this when neither the compile-time define nor
    // package.json answered. Treating it as "up to date" would strand that build.
    expect(isNewer('0.0.1', '0.0.0-unknown')).toBe(true);
    expect(isNewer('0.0.0', '0.0.0-unknown')).toBe(true);
  });

  test('normalizeVersion strips only the leading v', () => {
    expect(normalizeVersion(' v1.2.3 ')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3-preview')).toBe('1.2.3-preview');
  });
});

// ── asset naming ────────────────────────────────────────────────────────

describe('assetNameFor', () => {
  test('names the five assets release.yml actually publishes', () => {
    expect(assetNameFor('darwin', 'arm64')).toBe('yaar-macos-arm64');
    expect(assetNameFor('darwin', 'x64')).toBe('yaar-macos-x64');
    expect(assetNameFor('linux', 'x64')).toBe('yaar-linux-x64');
    expect(assetNameFor('linux', 'arm64')).toBe('yaar-linux-arm64');
    expect(assetNameFor('win32', 'x64')).toBe('yaar-windows-x64.exe');
  });

  test('returns null where no build is published', () => {
    // Windows arm64 has no release job — offering an x64 binary would be worse
    // than saying so.
    expect(assetNameFor('win32', 'arm64')).toBeNull();
    expect(assetNameFor('freebsd', 'x64')).toBeNull();
    expect(assetNameFor('linux', 'ia32')).toBeNull();
  });
});

// ── checksum manifest ───────────────────────────────────────────────────

describe('parseSums', () => {
  const hash = 'a'.repeat(64);
  const other = 'b'.repeat(64);

  test('reads the sha256sum format, including the binary marker', () => {
    const sums = parseSums(`${hash}  yaar-linux-x64\n${other} *yaar-apps.tar.gz\n`);
    expect(sums.get('yaar-linux-x64')).toBe(hash);
    expect(sums.get('yaar-apps.tar.gz')).toBe(other);
  });

  test('normalizes hashes to lowercase', () => {
    expect(parseSums(`${'A'.repeat(64)}  yaar-linux-x64`).get('yaar-linux-x64')).toBe(hash);
  });

  test('skips junk lines instead of failing the manifest', () => {
    const sums = parseSums(`# generated\n\nnot-a-hash  yaar-linux-x64\n${hash}  yaar-macos-arm64`);
    expect(sums.size).toBe(1);
    expect(sums.get('yaar-macos-arm64')).toBe(hash);
  });

  test('an entry names exactly one asset', () => {
    // `yaar-linux-x64` must not be read as the checksum of `yaar-linux-x64.exe`.
    const sums = parseSums(`${hash}  yaar-windows-x64.exe`);
    expect(sums.get('yaar-windows-x64')).toBeUndefined();
  });
});

// ── release fetch ───────────────────────────────────────────────────────

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const RELEASE_BODY = {
  tag_name: 'v9.9.9',
  name: 'YAAR 9.9.9',
  body: 'Notes here',
  html_url: 'https://github.com/sorryhyun/yaar/releases/tag/v9.9.9',
  published_at: '2026-07-01T00:00:00Z',
  prerelease: false,
  assets: [
    { name: 'yaar-linux-x64', size: 10, browser_download_url: 'https://example.test/linux' },
    { name: 'SHA256SUMS', size: 1, browser_download_url: 'https://example.test/sums' },
  ],
};

describe('fetchLatestRelease', () => {
  test('maps GitHub JSON onto ReleaseInfo', async () => {
    const release = await fetchLatestRelease(stubFetch(async () => jsonResponse(RELEASE_BODY)));
    expect(release.tag).toBe('v9.9.9');
    expect(release.version).toBe('9.9.9');
    expect(release.notes).toBe('Notes here');
    expect(release.assets.map((a) => a.name)).toEqual(['yaar-linux-x64', 'SHA256SUMS']);
  });

  test('drops assets missing a name or a download URL', async () => {
    const body = { ...RELEASE_BODY, assets: [{ name: 'orphan' }, { browser_download_url: 'x' }] };
    const release = await fetchLatestRelease(stubFetch(async () => jsonResponse(body)));
    expect(release.assets).toEqual([]);
  });

  test('explains a 403 as rate limiting rather than permissions', async () => {
    const rateLimited = stubFetch(
      async () => new Response('{}', { status: 403, statusText: 'Forbidden' }),
    );
    await expect(fetchLatestRelease(rateLimited)).rejects.toThrow(/rate-limited/i);
  });

  test('a release with no tag is an error, not a silent no-op', async () => {
    const noTag = stubFetch(async () => jsonResponse({ name: 'untagged' }));
    await expect(fetchLatestRelease(noTag)).rejects.toThrow(/tag_name/);
  });

  test('releaseIsNewer compares the tag against the running version', async () => {
    const release = await fetchLatestRelease(stubFetch(async () => jsonResponse(RELEASE_BODY)));
    expect(releaseIsNewer(release, '0.1.0')).toBe(true);
    expect(releaseIsNewer(release, '9.9.9')).toBe(false);
    expect(releaseIsNewer(release, '10.0.0')).toBe(false);
  });
});

// ── status + check ──────────────────────────────────────────────────────

describe('getUpdateStatus', () => {
  test('a source checkout reports itself unable to self-update', () => {
    // The test process is `bun test`, never the bundled exe, so this is the real
    // branch a developer hits — and the one the app turns into "use git pull".
    const status = getUpdateStatus();
    expect(status.bundled).toBe(false);
    expect(status.canInstall).toBe(false);
    expect(status.blockedReason).toBe('source-checkout');
    expect(status.progress.stage).toBe('idle');
  });

  test('carries the running version and platform', () => {
    const status = getUpdateStatus();
    expect(status.current).toBeString();
    expect(status.platform).toBe(process.platform);
    expect(status.arch).toBe(process.arch);
  });
});

describe('checkForUpdate', () => {
  test('records the latest release and whether it supersedes this build', async () => {
    setUpdateFetchForTest(stubFetch(async () => jsonResponse(RELEASE_BODY)));
    const status = await checkForUpdate(true);
    expect(status.checkError).toBeUndefined();
    expect(status.latest?.version).toBe('9.9.9');
    expect(status.latest?.updateAvailable).toBe(true);
    expect(status.checkedAt).toBeNumber();
  });

  test('caches, and force bypasses the cache', async () => {
    let calls = 0;
    setUpdateFetchForTest(
      stubFetch(async () => {
        calls++;
        return jsonResponse(RELEASE_BODY);
      }),
    );

    await checkForUpdate(true);
    await checkForUpdate();
    await checkForUpdate();
    expect(calls).toBe(1);

    await checkForUpdate(true);
    expect(calls).toBe(2);
  });

  test('a failed check is reported on the status, not thrown', async () => {
    // The app still has a version to show and a button to retry; throwing here
    // would blank the whole view over a flaky network.
    setUpdateFetchForTest(
      stubFetch(async () => {
        throw new Error('offline');
      }),
    );

    const status = await checkForUpdate(true);
    expect(status.checkError).toContain('offline');
    expect(status.latest).toBeUndefined();
    expect(status.current).toBeString();
  });

  test('flags a release that publishes no asset for this machine', async () => {
    setUpdateFetchForTest(stubFetch(async () => jsonResponse({ ...RELEASE_BODY, assets: [] })));

    const status = await checkForUpdate(true);
    expect(status.latest?.assetMissing).toBe(true);
    expect(status.canInstall).toBe(false);
  });
});

describe('startInstall', () => {
  test('refuses in a source checkout, naming git as the way out', async () => {
    setUpdateFetchForTest(stubFetch(async () => jsonResponse(RELEASE_BODY)));
    // Guards the one thing that must never happen by accident: a dev checkout
    // must not try to rename the bun binary out from under itself.
    await expect(startInstall()).rejects.toBeInstanceOf(UpdateRefused);
    await expect(startInstall()).rejects.toThrow(/git pull/);
  });

  test('refuses when already on the latest version', async () => {
    const current = getUpdateStatus().current;
    setUpdateFetchForTest(
      stubFetch(async () => jsonResponse({ ...RELEASE_BODY, tag_name: `v${current}` })),
    );

    await expect(startInstall()).rejects.toThrow(/latest version/);
  });

  test('refuses when GitHub could not be reached', async () => {
    setUpdateFetchForTest(
      stubFetch(async () => {
        throw new Error('offline');
      }),
    );

    await expect(startInstall()).rejects.toThrow(/Could not reach GitHub/);
  });
});

/**
 * `--version` probes for the provider CLIs.
 *
 * One per-boot cache shared by every caller — the providers' own `isAvailable()`
 * and the factory's availability checkers — so gating on presence or on a
 * version never costs a second spawn.
 */

/**
 * Successful CLI probes, keyed by command line. A binary that answered
 * `--version` once cannot vanish mid-process, so the probe runs once per boot.
 * Holds the in-flight promise so concurrent callers share a single spawn.
 * Failures are deliberately not cached: a missing binary fails fast (ENOENT)
 * and is cheap to re-probe, while the slow failure — a timeout under load — is
 * exactly the one that deserves a retry rather than a permanent verdict.
 */
const cliProbes = new Map<string, Promise<string | null>>();

/**
 * Spawn `cmd --version` without blocking the event loop.
 *
 * Resolves to the trimmed stdout on success (callers that only need "does it exist" ignore
 * it; the version-sensitive ones parse it) or null if the binary is missing or errored.
 * An empty answer still resolves to `''`, which is truthy-by-presence via the null check —
 * a CLI that exits 0 with no output is available, just not introspectable.
 */
async function probeCli(cmd: string, args: string[]): Promise<string | null> {
  const { execFile } = await import('child_process');
  return new Promise<string | null>((resolve) => {
    execFile(cmd, [...args, '--version'], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      resolve(`${stdout ?? ''}${stderr ?? ''}`.trim());
    });
  });
}

/**
 * Check whether a CLI tool is available, caching the answer per boot.
 *
 * The probe must never be synchronous: the MCP servers it gates are HTTP
 * endpoints served by this same process, so blocking here stalls the very
 * server the spawned CLI is about to connect to.
 *
 * @param spawnArgs - The command and any prefix args (e.g. from getClaudeSpawnArgs()).
 *                    '--version' is appended automatically.
 */
export async function isCliAvailable(...spawnArgs: string[]): Promise<boolean> {
  return (await cliVersionOutput(...spawnArgs)) !== null;
}

/**
 * Like {@link isCliAvailable}, but hands back what `--version` printed so the caller can
 * apply a version policy (see `codex/version.ts`). Returns null when the binary is absent
 * or failed to run. Shares the one probe cache, so gating on a version costs no extra spawn.
 */
export async function cliVersionOutput(...spawnArgs: string[]): Promise<string | null> {
  const [cmd, ...args] = spawnArgs;
  if (!cmd) return null;

  const key = spawnArgs.join('\0');
  const cached = cliProbes.get(key);
  if (cached) return cached;

  const probe = probeCli(cmd, args);
  cliProbes.set(key, probe);
  const result = await probe;
  if (result === null) {
    cliProbes.delete(key);
  }
  return result;
}

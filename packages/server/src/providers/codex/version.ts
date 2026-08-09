/**
 * Codex CLI version policy — the one place that says which CLI versions YAAR accepts.
 *
 * The Codex protocol bindings under `generated/` are *hand-generated* (`make codex-types`)
 * rather than pulled in as a versioned dependency, so nothing in the build notices when the
 * installed CLI drifts away from the shapes we compiled against. It surfaces much later
 * instead, as a notification whose params no longer match or a request method that was
 * renamed — runtime misbehavior that reads like a YAAR bug. Checking the version up front
 * turns that into one clear sentence at the point of failure.
 *
 * Two numbers, deliberately separate (the same split as `engines.bun` vs `.bun-version`):
 * `CODEX_MIN_VERSION` is the hand-edited floor we refuse to run below, and
 * `CODEX_GENERATED_FROM` (in `generated/codex-version.ts`) records what the bindings were
 * actually generated from. Only one direction of drift is safe, and the test enforces it:
 * generating from a CLI *newer* than the floor is fine (a release that only adds fields
 * leaves every shape we send unchanged, so the older CLI still speaks what we compiled),
 * while raising the floor *ahead* of a regeneration claims a protocol we have never
 * generated against and `codex-version.test.ts` refuses to let it ship.
 *
 * So the floor moves only when a release actually breaks something we send or read — not
 * on every codex version. It currently sits at 0.145.0 with bindings from 0.147.0.
 *
 * 0.147.0 is the first regeneration whose diff is *not* purely additive, so the "only adds
 * fields" reasoning above does not cover it on its own and the floor was re-derived by hand.
 * It replaced pinning with sections (`Thread.isPinned` → `section`/`sectionEnteredAt`,
 * `ThreadListParams.isPinned` → `sectionId`, `ThreadMetadataUpdateParams.isPinned` dropped
 * for a `thread/section/move` method), narrowed `ThreadSearchParams.sortKey` to its own
 * `ThreadSearchSortKey`, retyped two `AbsolutePathBuf` fields as `LegacyAppPathString`, and
 * re-shaped `ExternalAgentConfigImportHistoryRecordParams`. Every one of those types is
 * unreferenced outside `generated/` — this provider builds `thread/{start,resume,fork}`,
 * `turn/*` and `initialize`, none of which changed — so a 0.145/0.146 CLI still speaks
 * every shape we actually send, and its extra `isPinned` on a response is a field we never
 * read. Grep before trusting that: the argument is "unused", not "compatible".
 *
 * The additive half worth knowing about: `InitializeCapabilities.extensions`, the successor
 * to the `mcpServerOpenaiFormElicitation` flag and the seam a client declares MCP extensions
 * through. YAAR sends neither (`app-server.ts`'s `initializeParams`).
 *
 * This module is dependency-free on purpose: `scripts/codegen/codex-types.js` imports it
 * directly, so it must not drag in server internals.
 */

/**
 * Oldest `codex` CLI YAAR runs against. Raise this only alongside a `make codex-types`
 * regeneration — the floor is a claim about which protocol shapes we have actually seen.
 */
export const CODEX_MIN_VERSION = '0.145.0';

/**
 * Documented install path (`docs/reference/codex_protocol.md`), quoted in every error.
 *
 * Platform-split, and deliberately *not* the npm package: OpenAI's own installers are the
 * primary path in codex's README, and telling someone who installed that way to run
 * `npm install -g` leaves them with two codex binaries and no way to know which one PATH
 * resolves to — the exact confusion a version error is supposed to end.
 */
export const CODEX_UPGRADE_HINT =
  process.platform === 'win32'
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
    : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';

/** Matches a semver core plus any `-prerelease` / `+build` suffix. */
const VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

/**
 * Numeric dot-parts of a version core, ignoring any `-prerelease`/`+build` suffix.
 * Returns null for anything non-numeric so callers can decide how to treat "unknown".
 */
export function parseVersion(v: string): number[] | null {
  const core = v.trim().split('+')[0].split('-')[0];
  if (!core) return null;
  const nums = core.split('.').map((p) => Number(p));
  if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

/** Is `actual` >= `floor`? Unparseable input returns null — "cannot tell", not "no". */
export function isAtLeast(actual: string, floor: string): boolean | null {
  const a = parseVersion(actual);
  const b = parseVersion(floor);
  if (!a || !b) return null;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true; // equal satisfies the floor
}

/**
 * Pull the version out of `codex --version` output (`codex-cli 0.145.0`).
 * Returns null if the line carries no recognizable version.
 */
export function parseVersionOutput(stdout: string): string | null {
  return stdout.match(VERSION_PATTERN)?.[0] ?? null;
}

/**
 * Pull Codex's own version out of an `initialize` response `userAgent`, which looks like
 * `yaar/0.145.0 (Mac OS 26.5.2; arm64) Apple_Terminal/470.2 (yaar; 1.0.0)`.
 *
 * The leading name is *our* `clientInfo.name` echoed back, but the version beside it is the
 * app-server's, which is the point: it describes the process actually answering on the port,
 * not whichever binary `--version` happened to resolve to. Returns null if the shape changes.
 */
export function parseCodexUserAgent(userAgent: string): string | null {
  return userAgent.match(new RegExp(`^[^/\\s]+/(${VERSION_PATTERN.source})`))?.[1] ?? null;
}

/** Thrown when a located Codex CLI is too old to drive. Not retryable. */
export class CodexVersionError extends Error {
  constructor(
    readonly actual: string,
    readonly required: string = CODEX_MIN_VERSION,
  ) {
    super(
      `Codex CLI ${actual} is too old — YAAR requires ${required} or newer. ` +
        `Upgrade with: ${CODEX_UPGRADE_HINT}`,
    );
    this.name = 'CodexVersionError';
  }
}

/**
 * Reject an app-server too old to speak the protocol in `generated/`. Throws
 * {@link CodexVersionError}; returns silently when the version is acceptable or unknown.
 *
 * This is the last of three gates and the only one that sees the process actually answering
 * on the port: `make codex-types` checks the binary it generates from, the provider factory
 * checks whatever `--version` resolves to, and this checks whoever replied to `initialize`.
 * Those can differ — a stale app-server still holding `CODEX_WS_PORT` is exactly the case
 * `killStaleProcess` exists for, and it would sail past the other two.
 *
 * Fails *open* on a userAgent we cannot parse: the format belongs to OpenAI, and a cosmetic
 * change there must not brick a working install. Only a parsed, too-low version throws.
 */
export function assertSupportedCodex(
  userAgent: string,
  // Deliberately `console.warn`, not the structured logger: this module is dependency-free
  // (see the header — `scripts/codegen/codex-types.js` imports it directly), and importing
  // `observability/log.js` here would make the codegen script drag in a server internal.
  // The parameter is the seam for a caller that wants it routed elsewhere.
  warn: (message: string) => void = console.warn,
): void {
  const version = parseCodexUserAgent(userAgent);
  if (!version) {
    warn(`[codex] Could not read a version from userAgent "${userAgent}" — proceeding.`);
    return;
  }
  if (isAtLeast(version, CODEX_MIN_VERSION) === false) {
    throw new CodexVersionError(version);
  }
}

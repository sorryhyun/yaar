// Every state mutation and multi-step operation the app performs.
//
// Sits between store.ts (state, no behaviour) and the UI (markup, no
// behaviour): components call these and render signals, nothing more. The
// protocol commands call the same functions, so an agent and a click go down
// exactly one code path.
//
// Error convention: an action invoked from the UI reports its own failure via
// `reportError` or `tryToast` and resolves; an action a protocol command calls
// directly (`startScan`, `addServerByUrl`, ...) throws, so the agent gets the
// message instead of a silent success.
import { showConfirm, showToast, tryToast, withLoading } from '@bundled/yaar';
import { SCAN_BATCH_SIZE, SCAN_DEFAULTS } from './constants';
import * as gateway from './gateway';
import { logInfo, reportError } from './log';
import { probePort, probeUrl } from './mcp';
import {
  configuredUrls,
  probeInput,
  probeResult,
  scanFrom,
  scanHost,
  scanPath,
  scanTo,
  serverTools,
  setDiscovered,
  setExpandedServer,
  setLoading,
  setProbeResult,
  setProbing,
  setScanProgress,
  setScanning,
  setServerTools,
  setServers,
  expandedServer,
} from './store';
import type { DiscoveredServer } from './types';

// ── Loading ──────────────────────────────────────────────────

/** Re-read the configured list. Safe to call on every gateway change ping. */
export async function loadServers(): Promise<void> {
  try {
    setServers(await gateway.fetchServers());
  } catch (err) {
    // Both failure modes reach here: the read itself failed, or the persisted
    // config parsed as something we cannot interpret. Neither is "no servers
    // configured" — collapsing them into an empty list made a broken config
    // render exactly like a fresh install, so the toast is the only signal
    // that anything is wrong.
    reportError('Could not load MCP servers', err);
    setServers([]);
  }
}

/** Fill one server's tool list. Called lazily on expand, and after a refresh. */
export async function loadToolsFor(name: string): Promise<void> {
  try {
    const tools = await gateway.fetchTools(name);
    setServerTools((prev) => ({ ...prev, [name]: tools }));
  } catch (err) {
    // An empty tool list is a legitimate state (server connected, exposes
    // nothing), so the failure has to be reported out-of-band or the expanded
    // row's "No tools or not connected" is the only — and ambiguous — signal.
    reportError(`Could not load tools for "${name}"`, err);
    setServerTools((prev) => ({ ...prev, [name]: [] }));
  }
}

// ── Registration ──────────────────────────────────────────────
//
// Each of these pairs a gateway call with the reload that makes the change
// visible. Throws on failure — the caller (a toast wrapper, or a protocol
// command) decides what to do about it.

/** Register a server and re-read the list. Returns the name it landed under. */
export async function addServerByUrl(url: string, name?: string): Promise<string> {
  const finalName = await gateway.addServer(url, name);
  await loadServers();
  return finalName;
}

export async function removeServerByName(name: string): Promise<void> {
  await gateway.removeServer(name);
  await loadServers();
}

export async function refreshServerByName(name: string): Promise<void> {
  await gateway.refreshServer(name);
  await loadServers();
  await loadToolsFor(name);
}

// ── Discovery ───────────────────────────────────────────────

/**
 * Sweep a host/port range, publishing hits to `discovered` as they land.
 *
 * Returns only the *fresh* hits (not already configured), which is what the
 * protocol command reports; the progress line still counts everything found, so
 * a scan that turns up nothing new says so rather than reading as a failure.
 */
export async function startScan(): Promise<DiscoveredServer[]> {
  const host = scanHost().trim();
  const from = scanFrom();
  const to = scanTo();
  const path = scanPath().trim() || SCAN_DEFAULTS.path;
  if (!host) throw new Error('Host is required');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new Error(`Invalid port range ${from}-${to}`);
  }

  setScanning(true);
  setDiscovered([]);
  const found: DiscoveredServer[] = [];

  // Why each port came up empty, tallied by reason. `probePort` swallows its
  // failures on purpose, which is right per port and disastrous in aggregate:
  // a systemic fault (a missing permission, a bad path) looks exactly like a
  // quiet network. Counting reasons lets the summary below tell them apart.
  const failures = new Map<string, number>();
  const noteFailure = (reason: string) => failures.set(reason, (failures.get(reason) ?? 0) + 1);

  try {
    for (let batchStart = from; batchStart <= to; batchStart += SCAN_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + SCAN_BATCH_SIZE - 1, to);
      setScanProgress(`Scanning ports ${batchStart}-${batchEnd} of ${from}-${to}...`);

      const batch: Promise<DiscoveredServer | null>[] = [];
      for (let port = batchStart; port <= batchEnd; port++) {
        batch.push(probePort(host, port, path, noteFailure));
      }

      for (const hit of await Promise.all(batch)) {
        if (hit && !found.some((f) => f.url === hit.url)) {
          found.push(hit);
          setDiscovered([...found]);
        }
      }
    }
  } finally {
    setScanning(false);
  }

  // A sweep that found nothing and failed everywhere is the signature this app
  // shipped broken for two versions: every probe refused for the same reason,
  // reported to the user as an empty network. One captured line names it.
  if (found.length === 0 && failures.size > 0) {
    const [reason, count] = [...failures].sort((a, b) => b[1] - a[1])[0];
    logInfo(
      `scan of ${host}:${from}-${to}${path} found nothing; ` +
        `${count} probe(s) failed with: ${reason}`,
    );
  }

  const fresh = found.filter((f) => !configuredUrls().has(f.url));
  const skipped = found.length - fresh.length;
  setScanProgress(
    found.length === 0
      ? 'No MCP servers found'
      : `Found ${found.length} server(s)${skipped > 0 ? ` (${skipped} already configured)` : ''}`,
  );
  return fresh;
}

/** Probe the URL in the add-by-URL field. Reports its own failures. */
export async function runProbe(): Promise<void> {
  const url = probeInput().trim();
  if (!url) return;
  setProbing(true);
  setProbeResult(null);
  try {
    const result = await probeUrl(url);
    if (!result) {
      // Nothing MCP-shaped answered. Not an error — the URL is simply not a
      // server — so it is said plainly rather than through `reportError`.
      showToast('No MCP server responded at that URL', 'error');
      return;
    }
    setProbeResult(result);
  } catch (err) {
    reportError('Probe failed', err);
  } finally {
    setProbing(false);
  }
}

// ── UI actions ───────────────────────────────────────────────
//
// The click handlers: confirmation, busy flag and toasts, wrapped around the
// core operations above.

/** Add a discovered/probed server, then drop it from the discovery lists. */
export async function addDiscovered(server: DiscoveredServer): Promise<void> {
  // The success message names the server by the name it actually registered
  // under (only known after the call), so it stays inline rather than
  // `tryToast`'s static `success` option; `tryToast` still supplies the error
  // toast + log that `withLoading` alone would otherwise swallow silently.
  await withLoading(setLoading, () =>
    tryToast(async () => {
      const name = await addServerByUrl(server.url, server.serverName);
      showToast(`Added "${name}"`, 'success');
      setDiscovered((prev) => prev.filter((s) => s.url !== server.url));
      if (probeResult()?.url === server.url) setProbeResult(null);
    }),
  );
}

/** UI remove path: confirm first. The protocol command calls the core directly. */
export async function confirmRemove(name: string): Promise<void> {
  const ok = await showConfirm(`Remove "${name}" from your MCP servers?`, {
    title: 'Remove MCP server',
    okLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  await withLoading(setLoading, () =>
    tryToast(() => removeServerByName(name), { success: `Removed "${name}"` }),
  );
}

/** UI refresh path. */
export async function refreshServer(name: string): Promise<void> {
  await tryToast(() => refreshServerByName(name), { success: `Refreshed "${name}"` });
}

/** Expand a row, loading its tools the first time. Clicking the open row closes it. */
export function toggleExpand(name: string): void {
  if (expandedServer() === name) {
    setExpandedServer(null);
  } else {
    setExpandedServer(name);
    if (!serverTools()[name]) {
      void loadToolsFor(name);
    }
  }
}
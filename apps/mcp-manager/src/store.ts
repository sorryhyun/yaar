// The app's reactive state atoms — signals and the memos derived from them.
//
// Signals only: every mutation lives in actions.ts. That split keeps this file
// the single answer to "what state does the app hold?", and means a component
// importing a value here cannot accidentally reach a side effect.
//
// Module scope is deliberate. The signals outlive the view, so a protocol
// command can read and write them whether or not anything is mounted.
import { createMemo, createSignal } from '@bundled/solid-js';
import { createSharedSignal } from '@bundled/yaar';
import { SCAN_DEFAULTS } from './constants';
import type { DiscoveredServer, McpServer, McpTool } from './types';

// ── Configured servers ─────────────────────────────────────────────

/** Persisted config joined with live gateway status. */
export const [servers, setServers] = createSignal<McpServer[]>([]);

/** Name of the expanded row, or null. Only one expands at a time. */
export const [expandedServer, setExpandedServer] = createSignal<string | null>(null);

/** Tool lists by server name, filled lazily when a row is first expanded. */
export const [serverTools, setServerTools] = createSignal<Record<string, McpTool[]>>({});

/** Busy flag for the add/remove buttons. */
export const [loading, setLoading] = createSignal(false);

// ── Scan ───────────────────────────────────────────────────────

// Explicitly typed: SCAN_DEFAULTS is `as const`, so inference would pin each
// signal to its initial literal and reject anything the user types.
//
// Local signals, not shared directly: `ScanSection.ts` binds these to text/number
// inputs via onInput, which fires per keystroke — exactly the high-frequency case
// shared signals are not for. The `scan` command's own writes (below,
// `applyScanParams`) are the ones that need to reach every copy, since that's the
// "an agent's scan leaves the fields showing what it scanned" case the fields
// exist for; a user typing into the form is per-viewer editing.
export const [scanHost, setScanHost] = createSignal<string>(SCAN_DEFAULTS.host);
export const [scanFrom, setScanFrom] = createSignal<number>(SCAN_DEFAULTS.from);
export const [scanTo, setScanTo] = createSignal<number>(SCAN_DEFAULTS.to);
export const [scanPath, setScanPath] = createSignal<string>(SCAN_DEFAULTS.path);
export const [scanning, setScanning] = createSignal(false);
export const [scanProgress, setScanProgress] = createSignal('');

interface ScanParams {
  host: string;
  from: number;
  to: number;
  path: string;
}

const [, setScanParamsShared] = createSharedSignal<ScanParams>(
  'scanParams',
  {
    host: SCAN_DEFAULTS.host,
    from: SCAN_DEFAULTS.from,
    to: SCAN_DEFAULTS.to,
    path: SCAN_DEFAULTS.path,
  },
  {
    onRemote: (p) => {
      setScanHost(p.host);
      setScanFrom(p.from);
      setScanTo(p.to);
      setScanPath(p.path);
    },
  },
);

/**
 * Apply the `scan` command's params to the form fields on every copy — the one
 * write site for the shared half. Only fields the caller actually passed change;
 * the rest keep whatever is showing.
 */
export function applyScanParams(p: Partial<ScanParams>): void {
  if (p.host !== undefined) setScanHost(p.host);
  if (p.from !== undefined) setScanFrom(p.from);
  if (p.to !== undefined) setScanTo(p.to);
  if (p.path !== undefined) setScanPath(p.path);
  setScanParamsShared({ host: scanHost(), from: scanFrom(), to: scanTo(), path: scanPath() });
}

/**
 * Everything the last scan or probe turned up, configured or not. Shared: a scan
 * can be started by the agent (`scan` command) or by the toolbar's own Scan
 * button, and either way every copy should show the same hits as they land, not
 * just the copy that ran it.
 */
export const [discovered, setDiscovered] = createSharedSignal<DiscoveredServer[]>('discovered', []);

// ── Add by URL ─────────────────────────────────────────────────

export const [probeInput, setProbeInput] = createSignal('');
export const [probing, setProbing] = createSignal(false);
export const [probeResult, setProbeResult] = createSignal<DiscoveredServer | null>(null);

// ── Derived ──────────────────────────────────────────────────

/** URLs already registered — a scan hit matching one of these is not news. */
export const configuredUrls = createMemo(
  () =>
    new Set(
      servers()
        .map((s) => s.url)
        .filter((u): u is string => !!u),
    ),
);

/** What the discovery sections render: hits that are not already configured. */
export const visibleDiscovered = createMemo(() =>
  discovered().filter((d) => !configuredUrls().has(d.url)),
);

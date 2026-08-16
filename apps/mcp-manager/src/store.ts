// The app's reactive state atoms — signals and the memos derived from them.
//
// Signals only: every mutation lives in actions.ts. That split keeps this file
// the single answer to "what state does the app hold?", and means a component
// importing a value here cannot accidentally reach a side effect.
//
// Module scope is deliberate. The signals outlive the view, so a protocol
// command can read and write them whether or not anything is mounted.
import { createMemo, createSignal } from '@bundled/solid-js';
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
export const [scanHost, setScanHost] = createSignal<string>(SCAN_DEFAULTS.host);
export const [scanFrom, setScanFrom] = createSignal<number>(SCAN_DEFAULTS.from);
export const [scanTo, setScanTo] = createSignal<number>(SCAN_DEFAULTS.to);
export const [scanPath, setScanPath] = createSignal<string>(SCAN_DEFAULTS.path);
export const [scanning, setScanning] = createSignal(false);
export const [scanProgress, setScanProgress] = createSignal('');

/** Everything the last scan or probe turned up, configured or not. */
export const [discovered, setDiscovered] = createSignal<DiscoveredServer[]>([]);

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
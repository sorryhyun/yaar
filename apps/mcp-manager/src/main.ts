import { createSignal, createMemo, onMount, onCleanup, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import {
  defineApp,
  invoke,
  list,
  read,
  subscribe,
  showToast,
  showConfirm,
  withLoading,
  errMsg,
  safeParseOr,
  tryToast,
} from '@bundled/yaar';
import * as z from '@bundled/zod';
import {
  McpConfigResponse,
  McpServerConfig,
  McpServerStatus,
  McpStatusListResponse,
  McpToolInfo,
  McpToolListResponse,
} from './schema';
import { deriveName, probePort, probeUrl, type DiscoveredServer, type McpTool } from './mcp';
import './styles.css';

// ── Types ────────────────────────────────────────────────

interface McpServer {
  name: string;
  type: string;
  /** From the persisted config; dedupes scan results against what's configured. */
  url?: string;
  state: string;
  error?: string;
  toolCount?: number;
}

// ── State ────────────────────────────────────────────────

const [servers, setServers] = createSignal<McpServer[]>([]);
const [scanHost, setScanHost] = createSignal('127.0.0.1');
const [scanFrom, setScanFrom] = createSignal(3000);
const [scanTo, setScanTo] = createSignal(9000);
const [scanPath, setScanPath] = createSignal('/mcp');
const [scanning, setScanning] = createSignal(false);
const [scanProgress, setScanProgress] = createSignal('');
const [discovered, setDiscovered] = createSignal<DiscoveredServer[]>([]);
const [loading, setLoading] = createSignal(false);
const [expandedServer, setExpandedServer] = createSignal<string | null>(null);
const [serverTools, setServerTools] = createSignal<Record<string, McpTool[]>>({});

// Add-by-URL probe
const [probeInput, setProbeInput] = createSignal('');
const [probing, setProbing] = createSignal(false);
const [probeResult, setProbeResult] = createSignal<DiscoveredServer | null>(null);

/** URLs already registered — a scan hit matching one of these is not news. */
const configuredUrls = createMemo(
  () =>
    new Set(
      servers()
        .map((s) => s.url)
        .filter((u): u is string => !!u),
    ),
);

const visibleDiscovered = createMemo(() =>
  discovered().filter((d) => !configuredUrls().has(d.url)),
);

// ── Scanning ─────────────────────────────────────────────

const BATCH_SIZE = 20;

async function startScan(): Promise<DiscoveredServer[]> {
  const host = scanHost().trim();
  const from = scanFrom();
  const to = scanTo();
  const path = scanPath().trim() || '/mcp';
  if (!host) throw new Error('Host is required');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new Error(`Invalid port range ${from}-${to}`);
  }

  setScanning(true);
  setDiscovered([]);
  const found: DiscoveredServer[] = [];

  try {
    for (let batchStart = from; batchStart <= to; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, to);
      setScanProgress(`Scanning ports ${batchStart}-${batchEnd} of ${from}-${to}...`);

      const promises: Promise<DiscoveredServer | null>[] = [];
      for (let port = batchStart; port <= batchEnd; port++) {
        promises.push(probePort(host, port, path));
      }

      for (const r of await Promise.all(promises)) {
        if (r && !found.some((f) => f.url === r.url)) {
          found.push(r);
          setDiscovered([...found]);
        }
      }
    }
  } finally {
    setScanning(false);
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

async function runProbe() {
  const url = probeInput().trim();
  if (!url) return;
  setProbing(true);
  setProbeResult(null);
  try {
    const result = await probeUrl(url);
    if (!result) {
      showToast('No MCP server responded at that URL', 'error');
      return;
    }
    setProbeResult(result);
  } catch (err) {
    console.error('[mcp-manager] probe failed', err);
    showToast(`Probe failed: ${errMsg(err)}`, 'error');
  } finally {
    setProbing(false);
  }
}

// ── API ─────────────────────────────────────────────────

async function loadServers() {
  try {
    // Read config for names/types/urls, and runtime status for state/toolCount
    const [configRaw, statusRaw] = await Promise.all([
      read('yaar://config/mcp'),
      list<unknown>('yaar://mcp'),
    ]);
    // Validate the persisted config at the trust boundary. A missing config
    // (null/undefined) is coerced to `{}` before validating, which always
    // satisfies this loose schema — so `onInvalid` only ever fires for a config
    // that is *present* and malformed, not for a fresh install.
    const configParsed = safeParseOr(McpConfigResponse, configRaw ?? {}, undefined, {
      onInvalid: (issues) => {
        console.error('MCP config failed validation', issues);
        throw new Error('Malformed MCP config');
      },
    });
    // Annotated rather than left to `?? {}`: the bare empty-object literal widens
    // the union to `Record<string, McpServerConfig> | {}`, and `Object.entries`
    // over that union yields `unknown` values two calls downstream.
    const configs: Record<string, z.infer<typeof McpServerConfig>> = configParsed.servers ?? {};

    // The runtime status list crosses the same boundary as the config and gets
    // the same treatment. It is only a *decoration* of the config-derived list,
    // though, so an unreadable status is survivable in a way an unreadable
    // config is not: the row still renders, as "disconnected".
    const statusParsed = safeParseOr(McpStatusListResponse, statusRaw ?? {}, undefined, {
      label: 'mcp-manager:status',
    });
    const statusMap = new Map<string, z.infer<typeof McpServerStatus>>();
    for (const entry of statusParsed?.servers ?? []) {
      const row = safeParseOr(McpServerStatus, entry, undefined, {
        label: 'mcp-manager:status-entry',
      });
      if (!row) continue;
      statusMap.set(row.name, row);
    }

    setServers(
      Object.entries(configs).map(([name, cfg]) => {
        const status = statusMap.get(name);
        return {
          name,
          type: cfg.type,
          url: cfg.url,
          state: status?.state ?? 'disconnected',
          error: status?.error,
          toolCount: status?.toolCount,
        };
      }),
    );
  } catch (err) {
    // Both failure modes reach here: the read itself failed, or the persisted
    // config parsed as something we cannot interpret (the throw above). Neither
    // is "no servers configured" — collapsing them into an empty list made a
    // broken config render exactly like a fresh install.
    console.error('[mcp-manager] loading servers failed', err);
    showToast(`Could not load MCP servers: ${errMsg(err)}`, 'error');
    setServers([]);
  }
}

/**
 * Register a server through the gateway.
 *
 * `yaar://mcp` action:'add' writes the config *and* connects in one step; the
 * older path wrote `yaar://config/mcp` then fired a separate 'reload', which
 * left a window where the config and the live gateway disagreed.
 */
async function addServerByUrl(url: string, name?: string): Promise<string> {
  const finalName = (name ?? '').trim() || deriveName(url);
  await invoke('yaar://mcp', {
    action: 'add',
    name: finalName,
    config: { type: 'http', url },
  });
  await loadServers();
  return finalName;
}

async function removeServerByName(name: string): Promise<void> {
  await invoke('yaar://mcp', { action: 'remove', name });
  await loadServers();
}

async function refreshServerByName(name: string): Promise<void> {
  await invoke('yaar://mcp', { action: 'refresh', name });
  await loadServers();
  await loadToolsFor(name);
}

async function loadToolsFor(name: string) {
  try {
    const raw = await list<unknown>(`yaar://mcp/${encodeURIComponent(name)}`);
    const parsed = safeParseOr(McpToolListResponse, raw ?? {}, undefined, {
      onInvalid: (issues) => {
        console.error(`[mcp-manager] tool list for "${name}" failed validation`, issues);
        throw new Error('Malformed MCP tool list');
      },
    });
    const tools: McpTool[] = [];
    for (const entry of parsed.tools ?? []) {
      const row = safeParseOr(McpToolInfo, entry, undefined, {
        label: `mcp-manager:tool-entry:${name}`,
      });
      if (!row) continue;
      tools.push({ name: row.name, description: row.description });
    }
    setServerTools((prev) => ({ ...prev, [name]: tools }));
  } catch (err) {
    // An empty tool list is a legitimate state (server connected, exposes
    // nothing), so the failure has to be reported out-of-band or the expanded
    // row's "No tools or not connected" is the only — and ambiguous — signal.
    console.error(`[mcp-manager] loading tools for "${name}" failed`, err);
    showToast(`Could not load tools for "${name}": ${errMsg(err)}`, 'error');
    setServerTools((prev) => ({ ...prev, [name]: [] }));
  }
}

// ── UI actions ─────────────────────────────────────────────

async function addDiscovered(server: DiscoveredServer) {
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

/** UI remove path: confirm first. The agent command calls the core directly. */
async function confirmRemove(name: string) {
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

async function refreshServer(name: string) {
  await tryToast(() => refreshServerByName(name), { success: `Refreshed "${name}"` });
}

function toggleExpand(name: string) {
  if (expandedServer() === name) {
    setExpandedServer(null);
  } else {
    setExpandedServer(name);
    if (!serverTools()[name]) {
      loadToolsFor(name);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────

function stateDot(state: string) {
  if (state === 'connected') return 'y-dot y-dot-ok';
  if (state === 'connecting') return 'y-dot y-dot-warn';
  return 'y-dot y-dot-err';
}

// ── Components ────────────────────────────────────────────

function ToolList(tools: () => McpTool[]) {
  return html`
    <ul class="tool-list">
      <${For} each=${tools}>
        ${(tool: McpTool) => html`
          <li class="tool-item">
            <span class="tool-name">${tool.name}</span>
            <${Show} when=${tool.description}>
              <span class="tool-desc">${tool.description}</span>
            </>
          </li>
        `}
      </>
    </ul>
  `;
}

function DiscoveredCard(server: DiscoveredServer) {
  return html`
    <div class="y-card discovered-card">
      <div class="discovered-row">
        <span class="y-dot y-dot-ok"></span>
        <div class="server-info">
          <strong>
            ${
              server.serverName ??
              (server.port != null ? `Port ${server.port}` : deriveName(server.url))
            }
          </strong>
          <${Show} when=${server.serverVersion}>
            <span class="version">v${server.serverVersion}</span>
          </>
          <${Show} when=${server.protocolVersion}>
            <span class="proto-badge">MCP ${server.protocolVersion}</span>
          </>
          <span class="tool-count">
            ${server.tools.length} tool${server.tools.length !== 1 ? 's' : ''}
          </span>
          <span class="server-url">${server.url}</span>
        </div>
        <button
          class="y-btn y-btn-primary y-btn-sm"
          onClick=${() => addDiscovered(server)}
          disabled=${loading}
        >
          Add
        </button>
      </div>
      <${Show} when=${server.tools.length > 0}>
        ${() => ToolList(() => server.tools)}
      </>
    </div>
  `;
}

function ProbeSection() {
  return html`
    <section class="section">
      <h2 class="y-label">Add a server by URL</h2>
      <div class="probe-row">
        <input
          class="y-input probe-input"
          type="text"
          placeholder="http://127.0.0.1:3999/mcp"
          value=${probeInput}
          onInput=${(e: InputEvent) => setProbeInput((e.target as HTMLInputElement).value)}
          onKeyDown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') runProbe();
          }}
        />
        <button class="y-btn y-btn-primary" onClick=${runProbe} disabled=${probing}>
          ${() => (probing() ? 'Probing...' : 'Probe')}
        </button>
      </div>
      <${Show} when=${probeResult}>
        ${() => DiscoveredCard(probeResult()!)}
      </>
    </section>
  `;
}

function ScanSection() {
  return html`
    <section class="section">
      <h2 class="y-label">Scan for MCP servers</h2>

      <div class="scan-fields">
        <div class="scan-field">
          <label class="field-label">Host</label>
          <input
            class="y-input"
            type="text"
            value=${scanHost}
            onInput=${(e: InputEvent) => setScanHost((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="scan-field scan-field-sm">
          <label class="field-label">From</label>
          <input
            class="y-input"
            type="number"
            value=${scanFrom}
            onInput=${(e: InputEvent) => setScanFrom(Number((e.target as HTMLInputElement).value))}
          />
        </div>
        <div class="scan-field scan-field-sm">
          <label class="field-label">To</label>
          <input
            class="y-input"
            type="number"
            value=${scanTo}
            onInput=${(e: InputEvent) => setScanTo(Number((e.target as HTMLInputElement).value))}
          />
        </div>
        <div class="scan-field">
          <label class="field-label">Path</label>
          <input
            class="y-input"
            type="text"
            value=${scanPath}
            onInput=${(e: InputEvent) => setScanPath((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="scan-field scan-field-btn">
          <button
            class="y-btn y-btn-primary"
            onClick=${() => tryToast(() => startScan())}
            disabled=${scanning}
          >
            ${() => (scanning() ? 'Scanning...' : 'Scan')}
          </button>
        </div>
      </div>

      <${Show} when=${scanProgress}>
        <div class=${() => (scanning() ? 'scan-progress' : 'scan-done')}>${scanProgress}</div>
      </>

      <${For} each=${visibleDiscovered}>
        ${(server: DiscoveredServer) => DiscoveredCard(server)}
      </>
    </section>
  `;
}

function ServerList() {
  return html`
    <section class="section">
      <div class="section-header">
        <h2 class="y-label">Configured servers</h2>
        <span class="live-hint">live</span>
      </div>

      <${Show} when=${() => servers().length === 0}>
        <div class="y-empty">
          <div class="y-empty-icon">🔌</div>
          No MCP servers configured
        </div>
      </>

      <${For} each=${servers}>
        ${(server: McpServer) => html`
          <div class="y-card server-card">
            <div class="y-list-item server-row" onClick=${() => toggleExpand(server.name)}>
              <span class=${() => stateDot(server.state)}></span>
              <div class="server-info">
                <strong>${server.name}</strong>
                <span class="server-type">${server.type}</span>
                <${Show} when=${server.toolCount != null}>
                  <span class="tool-count">${server.toolCount} tools</span>
                </>
                <${Show} when=${server.error}>
                  <span class="server-error">${server.error}</span>
                </>
              </div>
              <div class="server-actions" onClick=${(e: Event) => e.stopPropagation()}>
                <button
                  class="y-btn y-btn-ghost y-btn-sm"
                  onClick=${() => refreshServer(server.name)}
                >Refresh</button>
                <button
                  class="y-btn y-btn-danger y-btn-sm"
                  onClick=${() => confirmRemove(server.name)}
                >Remove</button>
              </div>
            </div>

            <${Show} when=${() => expandedServer() === server.name}>
              <div class="server-tools">
                <${Show}
                  when=${() => (serverTools()[server.name]?.length ?? 0) > 0}
                  fallback=${html`<div class="no-tools">No tools or not connected</div>`}
                >
                  ${() => ToolList(() => serverTools()[server.name] ?? [])}
                </>
              </div>
            </>
          </div>
        `}
      </>
    </section>
  `;
}

function App() {
  onMount(() => {
    loadServers();

    // Live status: the gateway pings this URI whenever a server connects,
    // disconnects or its tool cache changes. Replaces the old manual Reload
    // button, which was the only way to notice a state change.
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    subscribe('yaar://mcp', () => {
      loadServers();
    })
      .then((fn) => {
        if (disposed) fn();
        else unsubscribe = fn;
      })
      .catch((err) => {
        console.error('[mcp-manager] live status subscription failed', err);
      });

    onCleanup(() => {
      disposed = true;
      unsubscribe?.();
    });
  });

  return html`
    <div class="y-app mcp-app">
      <${ProbeSection} />
      <${ScanSection} />
      <${ServerList} />
    </div>
  `;
}

// ── App Protocol ───────────────────────────────────────────

export default defineApp({
  id: 'mcp-manager',
  name: 'MCP Manager',
  state: {
    servers: {
      description: 'Configured MCP servers with live connection state, type, url and tool count.',
      get: () => servers(),
    },
    discovered: {
      description:
        'MCP servers found by the most recent scan or probe that are not yet configured.',
      get: () => visibleDiscovered(),
    },
  },
  commands: {
    scan: {
      description:
        'Scan a host/port range for MCP servers. Returns servers that are not already configured.',
      params: z.object({
        host: z.optional(z.string()),
        from: z.optional(z.number()),
        to: z.optional(z.number()),
        path: z.optional(z.string()),
      }),
      replay: 'never',
      run: async (p) => {
        if (p.host !== undefined) setScanHost(p.host);
        if (p.from !== undefined) setScanFrom(p.from);
        if (p.to !== undefined) setScanTo(p.to);
        if (p.path !== undefined) setScanPath(p.path);
        const found = await startScan();
        return {
          found: found.length,
          servers: found.map((s) => ({
            url: s.url,
            name: s.serverName,
            version: s.serverVersion,
            protocolVersion: s.protocolVersion,
            toolCount: s.tools.length,
          })),
        };
      },
    },
    addServer: {
      description:
        'Probe an MCP server URL and register it. Fails without adding if nothing MCP-shaped answers.',
      params: z.object({ url: z.string(), name: z.optional(z.string()) }),
      replay: 'never',
      run: async (p) => {
        const probed = await probeUrl(p.url);
        if (!probed) throw new Error(`No MCP server responded at ${p.url}`);
        const name = await addServerByUrl(p.url, p.name ?? probed.serverName);
        return {
          name,
          url: p.url,
          protocolVersion: probed.protocolVersion,
          tools: probed.tools.map((t) => t.name),
        };
      },
    },
    removeServer: {
      description: 'Unregister a configured MCP server by name.',
      params: z.object({ name: z.string() }),
      replay: 'never',
      run: async (p) => {
        await removeServerByName(p.name);
        return { removed: p.name };
      },
    },
    refreshServer: {
      description: 'Force-refresh the tool cache and connection state for one configured server.',
      params: z.object({ name: z.string() }),
      replay: 'never',
      run: async (p) => {
        await refreshServerByName(p.name);
        const server = servers().find((s) => s.name === p.name);
        return {
          name: p.name,
          state: server?.state ?? 'unknown',
          toolCount: server?.toolCount,
          tools: (serverTools()[p.name] ?? []).map((t) => t.name),
        };
      },
    },
  },
  view: App,
});

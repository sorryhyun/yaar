import { createSignal, onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { invoke, list, read, del, showToast, withLoading } from '@bundled/yaar';
import './styles.css';

// ── Types ────────────────────────────────────────────────────────

interface McpServer {
  name: string;
  type: string;
  state: string;
  error?: string;
  toolCount?: number;
}

interface McpTool {
  name: string;
  description?: string;
}

interface HttpResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface DiscoveredServer {
  url: string;
  port: number;
  serverName?: string;
  serverVersion?: string;
  tools: McpTool[];
}

// ── State ────────────────────────────────────────────────────────

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

// ── MCP JSON-RPC helpers ─────────────────────────────────────────

let rpcId = 0;

function jsonRpcRequest(method: string, params?: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params ?? {} });
}

function jsonRpcNotification(method: string) {
  return JSON.stringify({ jsonrpc: '2.0', method });
}

async function mcpPost(url: string, body: string, sessionId?: string): Promise<HttpResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return invoke<HttpResult>('yaar://http', { url, method: 'POST', headers, body });
}

/** Parse JSON-RPC response from body — handles both direct JSON and SSE format. */
function parseRpcResponse(body: string): unknown {
  // Try direct JSON first
  try {
    const parsed = JSON.parse(body);
    if (parsed.result !== undefined) return parsed.result;
    if (parsed.error) throw new Error(parsed.error.message ?? 'JSON-RPC error');
    return parsed;
  } catch {
    // Try SSE format: look for "data: {...}" lines
    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.result !== undefined) return parsed.result;
          if (parsed.error) throw new Error(parsed.error.message ?? 'JSON-RPC error');
        } catch {
          // skip malformed SSE lines
        }
      }
    }
    throw new Error('Could not parse MCP response');
  }
}

// ── Scanning ─────────────────────────────────────────────────────

const BATCH_SIZE = 20;

/** Try to probe a single port. Returns DiscoveredServer on success, null on failure. */
async function probePort(host: string, port: number, path: string): Promise<DiscoveredServer | null> {
  const url = `http://${host}:${port}${path}`;
  try {
    const initRes = await mcpPost(
      url,
      jsonRpcRequest('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'yaar-mcp-manager', version: '1.0.0' },
      }),
    );
    if (!initRes.ok) return null;
    const initResult = parseRpcResponse(initRes.body) as {
      serverInfo?: { name?: string; version?: string };
    };
    const sessionId = initRes.headers['mcp-session-id'];

    await mcpPost(url, jsonRpcNotification('notifications/initialized'), sessionId);

    const toolsRes = await mcpPost(url, jsonRpcRequest('tools/list'), sessionId);
    const toolsResult = parseRpcResponse(toolsRes.body) as {
      tools?: Array<{ name: string; description?: string }>;
    };

    return {
      url,
      port,
      serverName: initResult.serverInfo?.name,
      serverVersion: initResult.serverInfo?.version,
      tools: (toolsResult.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
    };
  } catch {
    return null;
  }
}

async function startScan() {
  const host = scanHost().trim();
  const from = scanFrom();
  const to = scanTo();
  const path = scanPath().trim() || '/mcp';
  if (!host || from > to) return;

  setScanning(true);
  setDiscovered([]);
  const found: DiscoveredServer[] = [];

  for (let batchStart = from; batchStart <= to; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, to);
    setScanProgress(`Scanning ports ${batchStart}-${batchEnd} of ${from}-${to}...`);

    const promises: Promise<DiscoveredServer | null>[] = [];
    for (let port = batchStart; port <= batchEnd; port++) {
      promises.push(probePort(host, port, path));
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r) {
        found.push(r);
        setDiscovered([...found]);
      }
    }
  }

  setScanProgress(found.length > 0 ? `Found ${found.length} server(s)` : 'No MCP servers found');
  setScanning(false);
}

// ── API ──────────────────────────────────────────────────────────

async function loadServers() {
  try {
    // Read config for names/types, and runtime status for state/toolCount
    const [configData, statusData] = await Promise.all([
      read<{ servers: Record<string, { type: string; url?: string; command?: string }> }>('yaar://config/mcp'),
      list<{ servers: McpServer[] }>('yaar://mcp'),
    ]);
    const configs = configData?.servers ?? {};
    const statuses = statusData?.servers ?? [];
    const statusMap = new Map(statuses.map((s) => [s.name, s]));

    setServers(
      Object.entries(configs).map(([name, cfg]) => {
        const status = statusMap.get(name);
        return {
          name,
          type: cfg.type,
          state: status?.state ?? 'disconnected',
          error: status?.error,
          toolCount: status?.toolCount,
        };
      }),
    );
  } catch {
    setServers([]);
  }
}

async function addDiscovered(server: DiscoveredServer) {
  const name = server.serverName || `mcp-${server.port}`;
  await withLoading(setLoading, async () => {
    await invoke('yaar://config/mcp', { name, config: { type: 'http', url: server.url } });
    await invoke('yaar://mcp', { action: 'reload' });
    showToast(`Added "${name}"`, 'success');
    setDiscovered((prev) => prev.filter((s) => s.url !== server.url));
    await loadServers();
  });
}

async function removeServer(name: string) {
  await withLoading(setLoading, async () => {
    await del(`yaar://config/mcp/${name}`);
    await invoke('yaar://mcp', { action: 'reload' });
    showToast(`Removed "${name}"`, 'success');
    await loadServers();
  });
}

async function refreshServer(name: string) {
  try {
    await invoke('yaar://mcp', { action: 'refresh', name });
    showToast(`Refreshed "${name}"`, 'success');
    await loadServers();
    await loadToolsFor(name);
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Refresh failed', 'error');
  }
}

async function loadToolsFor(name: string) {
  try {
    const data = await list<{ tools: McpTool[] }>(`yaar://mcp/${name}`);
    setServerTools((prev) => ({ ...prev, [name]: data?.tools ?? [] }));
  } catch {
    setServerTools((prev) => ({ ...prev, [name]: [] }));
  }
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

// ── Helpers ──────────────────────────────────────────────────────

function stateDot(state: string) {
  if (state === 'connected') return 'dot dot-ok';
  if (state === 'connecting') return 'dot dot-warn';
  return 'dot dot-err';
}

// ── Components ───────────────────────────────────────────────────

function ScanSection() {
  return html`
    <section class="section">
      <h2 class="y-label">Scan for MCP Servers</h2>

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
            onClick=${startScan}
            disabled=${scanning}
          >
            ${() => scanning() ? 'Scanning...' : 'Scan'}
          </button>
        </div>
      </div>

      <${Show} when=${scanProgress}>
        <div class=${() => scanning() ? 'scan-progress' : 'scan-done'}>${scanProgress}</div>
      </>

      <${For} each=${discovered}>
        ${(server: DiscoveredServer) => html`
          <div class="y-card discovered-card">
            <div class="discovered-row">
              <span class="dot dot-ok"></span>
              <div class="server-info">
                <strong>${server.serverName ?? `Port ${server.port}`}</strong>
                <${Show} when=${server.serverVersion}>
                  <span class="version">v${server.serverVersion}</span>
                </>
                <span class="tool-count">${server.tools.length} tool${server.tools.length !== 1 ? 's' : ''}</span>
                <span class="server-url">${server.url}</span>
              </div>
              <button
                class="y-btn y-btn-primary btn-sm"
                onClick=${() => addDiscovered(server)}
                disabled=${loading}
              >
                Add
              </button>
            </div>
            <${Show} when=${() => server.tools.length > 0}>
              <ul class="tool-list">
                <${For} each=${() => server.tools}>
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
            </>
          </div>
        `}
      </>
    </section>
  `;
}

function ServerList() {
  return html`
    <section class="section">
      <div class="section-header">
        <h2 class="y-label">Configured Servers</h2>
        <button class="y-btn y-btn-ghost btn-sm" onClick=${loadServers}>Reload</button>
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
            <div
              class="y-list-item server-row"
              onClick=${() => toggleExpand(server.name)}
            >
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
                  class="y-btn y-btn-ghost btn-sm"
                  onClick=${() => refreshServer(server.name)}
                >Refresh</button>
                <button
                  class="y-btn y-btn-ghost y-btn-danger btn-sm"
                  onClick=${() => removeServer(server.name)}
                >Remove</button>
              </div>
            </div>

            <${Show} when=${() => expandedServer() === server.name}>
              <div class="server-tools">
                <${Show}
                  when=${() => (serverTools()[server.name]?.length ?? 0) > 0}
                  fallback=${html`<div class="no-tools">No tools or not connected</div>`}
                >
                  <ul class="tool-list">
                    <${For} each=${() => serverTools()[server.name] ?? []}>
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
  });

  return html`
    <div class="y-app mcp-app">
      <${ScanSection} />
      <${ServerList} />
    </div>
  `;
}

render(() => html`<${App} />`, document.getElementById('app')!);

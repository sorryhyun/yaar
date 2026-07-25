import { createSignal, onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { invoke, list, read, del, httpFetch, showToast, withLoading, errMsg } from '@bundled/yaar';
import * as z from '@bundled/zod';
import {
  JsonRpcResponse,
  McpConfigResponse,
  McpServerStatus,
  McpStatusListResponse,
  McpToolInfo,
  McpToolListResponse,
} from './schema';
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

async function mcpPost(url: string, body: string, sessionId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return httpFetch(url, { method: 'POST', headers, body });
}

/** JSON.parse that answers "not JSON" with `undefined` instead of throwing. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read the JSON-RPC payload out of a response body — direct JSON or SSE framing.
 *
 * Only the *decode* decides which framing this is; everything after it (schema
 * failure, and a well-formed `error` envelope) throws for the caller. That
 * separation is the point: the earlier version wrapped the whole direct-JSON
 * branch in a try whose catch fell through to the SSE scan, so a legitimate
 * `error.message` from the server — and the schema failure too — was swallowed
 * and re-reported as the generic "Could not parse MCP response". The server's
 * own explanation of what went wrong is the most useful thing in the exchange;
 * it must not be lost to control flow.
 */
function parseRpcResponse(body: string): unknown {
  const direct = tryJson(body);
  if (direct !== undefined) {
    const parsed = z.safeParse(JsonRpcResponse, direct);
    if (!parsed.success) {
      console.error('MCP JSON-RPC response failed validation', parsed.error.issues);
      throw new Error('Malformed MCP JSON-RPC response');
    }
    const data = parsed.data;
    if (data.result !== undefined) return data.result;
    if (data.error) throw new Error(data.error.message ?? 'JSON-RPC error');
    return data;
  }

  // Not JSON on its own — SSE framing: look for "data: {...}" lines. A line that
  // does not decode is skipped (an SSE stream legitimately carries other
  // frames); a line that decodes and *is* an error envelope throws, as above.
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const value = tryJson(line.slice(6));
    if (value === undefined) continue;
    const parsed = z.safeParse(JsonRpcResponse, value);
    if (!parsed.success) {
      console.error('MCP SSE data line failed validation', parsed.error.issues);
      continue;
    }
    const data = parsed.data;
    if (data.result !== undefined) return data.result;
    if (data.error) throw new Error(data.error.message ?? 'JSON-RPC error');
  }
  throw new Error('Could not parse MCP response');
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
    // httpFetch does not throw on 4xx/5xx — a non-MCP service answering on this
    // port is a normal scan outcome, not an error.
    if (!initRes.ok) return null;
    // The body is either JSON or an SSE stream; parseRpcResponse handles both,
    // so read it as text rather than committing to res.json().
    const initResult = parseRpcResponse(await initRes.text()) as {
      serverInfo?: { name?: string; version?: string };
    };
    // Headers.get() is case-insensitive, unlike the plain-object lookup this replaced.
    const sessionId = initRes.headers.get('mcp-session-id') ?? undefined;

    await mcpPost(url, jsonRpcNotification('notifications/initialized'), sessionId);

    const toolsRes = await mcpPost(url, jsonRpcRequest('tools/list'), sessionId);
    const toolsResult = parseRpcResponse(await toolsRes.text()) as {
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
    const [configRaw, statusRaw] = await Promise.all([
      read('yaar://config/mcp'),
      list<unknown>('yaar://mcp'),
    ]);
    // Validate the persisted config at the trust boundary. A missing config
    // (null/undefined) is normal — treat it as an empty `{}` rather than a
    // validation failure so first-run users don't see a spurious error.
    const configParsed = z.safeParse(McpConfigResponse, configRaw ?? {});
    if (!configParsed.success) {
      console.error('MCP config failed validation', configParsed.error.issues);
      throw new Error('Malformed MCP config');
    }
    const configs = configParsed.data.servers ?? {};

    // The runtime status list crosses the same boundary as the config and gets
    // the same treatment. It is only a *decoration* of the config-derived list,
    // though, so an unreadable status is survivable in a way an unreadable
    // config is not: the row still renders, as "disconnected".
    const statusParsed = z.safeParse(McpStatusListResponse, statusRaw ?? {});
    if (!statusParsed.success) {
      console.error('[mcp-manager] MCP status list failed validation', statusParsed.error.issues);
    }
    const statusMap = new Map<string, z.infer<typeof McpServerStatus>>();
    for (const entry of statusParsed.success ? (statusParsed.data.servers ?? []) : []) {
      const row = z.safeParse(McpServerStatus, entry);
      if (!row.success) {
        console.error('[mcp-manager] MCP status entry failed validation', {
          entry,
          issues: row.error.issues,
        });
        continue;
      }
      statusMap.set(row.data.name, row.data);
    }

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
    showToast(errMsg(err), 'error');
  }
}

async function loadToolsFor(name: string) {
  try {
    const raw = await list<unknown>(`yaar://mcp/${name}`);
    const parsed = z.safeParse(McpToolListResponse, raw ?? {});
    if (!parsed.success) {
      console.error(`[mcp-manager] tool list for "${name}" failed validation`, parsed.error.issues);
      throw new Error('Malformed MCP tool list');
    }
    const tools: McpTool[] = [];
    for (const entry of parsed.data.tools ?? []) {
      const row = z.safeParse(McpToolInfo, entry);
      if (!row.success) {
        console.error(`[mcp-manager] tool entry for "${name}" failed validation`, {
          entry,
          issues: row.error.issues,
        });
        continue;
      }
      tools.push({ name: row.data.name, description: row.data.description });
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

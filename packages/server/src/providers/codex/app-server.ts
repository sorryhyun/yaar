/**
 * App-server process manager for Codex (WebSocket transport).
 *
 * Manages the lifecycle of a `codex app-server` child process:
 * - Spawns with `--listen ws://127.0.0.1:{port}` for WebSocket transport
 * - Maintains a control client for auth and account operations
 * - Exposes `createConnection()` so each CodexProvider gets its own WS connection
 * - Owned by WarmPool singleton (single owner, no refcounting)
 *
 * Each provider's WebSocket carries its own notifications/requests, so the
 * single-turn serialization mutex is no longer needed.
 */

import type { Subprocess } from 'bun';
import { EventEmitter } from 'node:events';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonRpcWsClient } from './jsonrpc-ws-client.js';
import { getMcpToken } from '../../mcp/index.js';
import {
  getCodexSpawnArgs,
  getCodexAppServerArgs,
  getCodexWsPort,
  detectUserMcpServers,
  DISABLED_FEATURES,
  ENABLED_FEATURES,
  STORAGE_DIR,
} from '../../config.js';
import { CODEX_AGENT_ROLES, codexRoleToToml } from '../../agents/profiles/index.js';
import { assertSupportedCodex, CodexVersionError } from './version.js';
import type {
  InitializeParams,
  InitializeResponse,
  GetAccountParams,
  GetAccountResponse,
  LoginAccountParams,
  LoginAccountResponse,
  CancelLoginAccountParams,
  CancelLoginAccountResponse,
} from './types.js';

/**
 * Configuration for the app-server.
 */
export interface AppServerConfig {
  /** Model to use (default: gpt-5.6-terra) */
  model?: string;
  /** Request timeout in milliseconds */
  requestTimeout?: number;
}

/** No-op 'error' subscriber; see the AppServer constructor. */
const NOOP = (): void => {};

/**
 * Print what this launch is *asking* codex for: the feature opt-outs, the opt-ins, and the
 * user MCP servers being switched off.
 *
 * Worth a line at boot because a `-c` codex declines is otherwise invisible — it exits 0, and
 * even a key that names no flag at all is accepted silently (`-c totally_bogus_key=1` → exit
 * 0). Two overrides sat in `DISABLED_FEATURES` for a while looking honored while doing
 * nothing: `code_mode.enabled` (wrong key shape — the flag is the plain bool `code_mode`) and
 * `tool_search_always_defer_mcp_tools` (a `removed`-stage flag pinned to `true` that no `-c`
 * or `--disable` moves).
 *
 * So this is deliberately the list YAAR **sent**, not the list codex **accepted** — printing
 * an accepted list we did not measure would be the same false assurance in a new place. To
 * get the accepted one, run `codex doctor --json` with the same args and read
 * `checks['config.load'].details['feature flag overrides']`; diffing the two after a codex
 * upgrade is how a silently-dropped override gets caught. Note codex omits an override that
 * changes nothing (a flag already at that value), so an entry missing from its list is either
 * inert or refused — `codex features list` distinguishes them.
 */
function logRequestedFeatures(): void {
  const userServers = detectUserMcpServers();
  console.log(
    `[codex] feature opt-outs (${DISABLED_FEATURES.length}): ${DISABLED_FEATURES.join(', ')}`,
  );
  console.log(
    `[codex] feature opt-ins (${ENABLED_FEATURES.length}): ${ENABLED_FEATURES.join(', ')}`,
  );
  console.log(
    `[codex] user MCP servers disabled (${userServers.length}): ${userServers.join(', ') || 'none'}`,
  );
}

/**
 * Resolve `setsid`, used to launch the app-server as its own
 * process-group / session leader. When available, the whole codex process tree
 * (app-server + any grandchildren it spawns — model runners, MCP servers, turn
 * processes) shares one PGID, so shutdown can reap it with a single negative-PID
 * signal instead of leaking orphans. Returns the binary path, or null on Windows
 * (no setsid; the process-tree is force-killed via taskkill /T elsewhere) or
 * platforms where it isn't installed (e.g. stock macOS) — there we fall back to
 * single-PID kill. Cached after the first probe.
 */
let setsidPathCache: string | null | undefined;
function getSetsidPath(): string | null {
  if (setsidPathCache === undefined) {
    setsidPathCache = process.platform === 'win32' ? null : (Bun.which('setsid') ?? null);
  }
  return setsidPathCache;
}

/**
 * Manages a codex app-server child process with WebSocket transport.
 *
 * @example
 * ```ts
 * const server = new AppServer();
 * await server.start();
 *
 * // Each provider gets its own connection
 * const conn = await server.createConnection();
 * const { threadId } = await conn.request('thread/start', { ... });
 * await conn.request('turn/start', { threadId, input: [...] });
 *
 * await server.stop();
 * ```
 */
/* eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging --
   Standard typed-EventEmitter idiom: these overloads only narrow the on/off/emit
   already implemented by the EventEmitter base, so nothing is left unimplemented. */
export interface AppServer {
  on(event: 'notification', listener: (method: string, params: unknown) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'notification', listener: (method: string, params: unknown) => void): this;
  off(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  emit(event: 'notification', method: string, params: unknown): boolean;
  emit(event: 'exit', code: number | null, signal: string | null): boolean;
  emit(event: 'error', error: Error): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see above
export class AppServer extends EventEmitter {
  private process: Subprocess | null = null;
  /**
   * True when `process` was launched via `setsid` and is therefore the leader
   * of its own process group (PGID === process.pid). Lets `stop()` signal the
   * whole codex subtree with `process.kill(-pid, …)` instead of just the leader.
   */
  private ownsProcessGroup = false;
  private controlClient: JsonRpcWsClient | null = null;
  private tempDir: string | null = null;
  private readonly config: AppServerConfig;
  private readonly wsPort: number;

  // Capabilities received from initialize handshake
  private initializeResult: InitializeResponse | null = null;

  constructor(config: AppServerConfig = {}) {
    super();
    // EventEmitter *throws* on an 'error' event with no listener, whereas the
    // hand-rolled fan-out this replaced dropped it silently. Keep the old
    // semantics with a permanent no-op subscriber (see removeAllListeners).
    this.on('error', NOOP);
    // The previous listener arrays had no cap; opt out of the 10-listener warning.
    this.setMaxListeners(0);
    this.config = config;
    this.wsPort = getCodexWsPort();
  }

  /**
   * Drop subscribers, but keep the 'error' guard so an unhandled provider error
   * still can't throw.
   */
  removeAllListeners(event?: string | symbol): this {
    super.removeAllListeners(event);
    if (event === undefined || event === 'error') this.on('error', NOOP);
    return this;
  }

  private get initializeParams(): InitializeParams {
    return {
      clientInfo: { name: 'yaar', title: 'YAAR Desktop', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error('AppServer is already running');
    }

    this.tempDir = await mkdtemp(join(tmpdir(), 'codex-'));

    // Write agent role config files so subagents inherit the correct model
    const agentsDir = join(this.tempDir, 'agents');
    await mkdir(agentsDir);
    for (const [role, config] of Object.entries(CODEX_AGENT_ROLES)) {
      await Bun.write(join(agentsDir, `${role}.toml`), codexRoleToToml(config, this.config.model));
    }

    await this.spawnProcess();

    try {
      await this.connectControlClient();
    } catch (err) {
      // Nothing upstream calls stop() on a failed start, so a process spawned here would
      // otherwise outlive the failure and keep holding the WS port — leaving the next boot
      // to blame `killStaleProcess`. Matters most for the version check, which fails on the
      // very first attempt and would strand a fully-launched app-server every time.
      await this.stop().catch(() => {});
      throw err;
    }
  }

  /**
   * Kill any stale process occupying the WebSocket port.
   * This handles the case where a previous YAAR server crashed without
   * cleaning up its detached codex app-server process.
   * Tries multiple tools for cross-platform compatibility (Linux, macOS, WSL, Windows).
   */
  private killStaleProcess(): void {
    if (process.platform !== 'win32') {
      try {
        const r = Bun.spawnSync(['fuser', '-k', `${this.wsPort}/tcp`], {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 5000,
        });
        if (r.exitCode === 0) {
          console.log(`[codex] Killed stale process on port ${this.wsPort} (fuser)`);
          return;
        }
      } catch {
        // fuser not available
      }

      try {
        const r = Bun.spawnSync(['lsof', '-ti', `tcp:${this.wsPort}`], {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        });
        const output = new TextDecoder().decode(r.stdout as Uint8Array).trim();
        if (output) {
          for (const line of output.split('\n')) {
            const pid = parseInt(line.trim(), 10);
            if (pid > 0) {
              try {
                process.kill(pid, 9);
              } catch {
                // Already dead
              }
            }
          }
          console.log(`[codex] Killed stale process on port ${this.wsPort} (lsof)`);
          return;
        }
      } catch {
        // lsof not available
      }
    }

    // Windows native or WSL fallback: try PowerShell to kill Windows-side processes
    try {
      const ps = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
      Bun.spawnSync(
        [
          ps,
          '-NoProfile',
          '-Command',
          `Get-NetTCPConnection -LocalPort ${this.wsPort} -State Listen -ErrorAction SilentlyContinue | ` +
            `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000 },
      );
    } catch {
      // PowerShell not available — proceed anyway
    }
  }

  private async spawnProcess(): Promise<void> {
    this.killStaleProcess();

    // No YAAR MCP servers at the process level: `CodexProvider.buildMcpScope` is the only
    // place that declares them, per thread, and it is the only place that *can* — the
    // process-level entries carry no agent identity, so a tool call arriving through one
    // is anonymous. Every real turn supplies an agentId (`AgentSession` passes its own
    // instanceId), so this was never the live path, only a fallback nothing reached.
    //
    // It has to be empty rather than merely filtered, because a thread's `mcp_servers`
    // override *merges* over the loaded config instead of replacing it — a server declared
    // here cannot be taken away per thread. That is what made a sub-agent's allowlist
    // unenforceable on this provider: its thread named `subagent` alone and still inherited
    // every namespace listed here. Declaring none makes the per-thread set authoritative.
    const args = getCodexAppServerArgs();

    logRequestedFeatures();

    args.push('--listen', `ws://127.0.0.1:${this.wsPort}`);

    if (this.config.model) {
      args.push('-c', `model=${this.config.model}`);

      // Point subagent roles at config files (written in start())
      if (this.tempDir) {
        for (const role of Object.keys(CODEX_AGENT_ROLES)) {
          args.push(
            '-c',
            `agents.${role}.config_file=${join(this.tempDir, 'agents', `${role}.toml`)}`,
          );
        }
      }
    }

    const codexArgs = [...getCodexSpawnArgs(), ...args];
    const codexBin = codexArgs[0];

    // Resolve the codex binary up front. We can't rely on Bun.spawn's ENOENT
    // anymore: when we wrap the launch in `setsid` (below) a missing codex no
    // longer surfaces as a spawn failure — setsid spawns fine and only fails to
    // exec codex afterwards, which would degrade into an opaque connect timeout.
    const codexFound =
      codexBin.includes('/') || codexBin.includes('\\')
        ? existsSync(codexBin)
        : Bun.which(codexBin) !== null;
    if (!codexFound) {
      throw new Error(
        `Codex CLI not found (tried: ${codexBin}). ` +
          `Install it (npm install -g @openai/codex) or place the codex binary next to the executable.`,
      );
    }

    // Launch as a process-group / session leader when `setsid` is available, so
    // shutdown can reap the entire codex subtree with one negative-PID signal.
    // `setsid -w` keeps the leader alive for codex's lifetime and propagates its
    // exit code, so `process.exited` and stderr piping still work; the leader's
    // PID equals the new PGID.
    const setsidPath = getSetsidPath();
    const spawnArgs = setsidPath ? [setsidPath, '-w', ...codexArgs] : codexArgs;
    this.ownsProcessGroup = setsidPath !== null;

    this.process = Bun.spawn(spawnArgs, {
      cwd: STORAGE_DIR,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        YAAR_MCP_TOKEN: getMcpToken(),
        // Protocol era for **stdio** MCP servers only. This is deliberately not the switch
        // that puts YAAR's own servers on the modern leg — those are HTTP, and the CLI reads
        // this var only on the stdio path ("unsupported CODEX_MCP_PROTOCOL_VERSION `…` for
        // stdio MCP server; expected `2026-07-28`"). Setting it alone left every YAAR thread
        // on the 2025-era stateful leg; `features.mcp_2026_07_28` in `getCodexAppServerArgs()`
        // is what actually moves them, and that comment carries the measurement. Kept because
        // a stdio server can still reach a thread (the user's config declares one, YAAR's
        // blanket disable misses it) and a bad value here is refused loudly rather than
        // silently downgraded.
        CODEX_MCP_PROTOCOL_VERSION: '2026-07-28',
      },
    });

    // Log stderr for debugging (async, runs in background)
    const stderrStream = this.process.stderr as ReadableStream<Uint8Array>;
    (async () => {
      try {
        const reader = stderrStream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const message = decoder.decode(value).trim();
          if (message) {
            console.error(`[codex app-server stderr] ${message}`);
          }
        }
      } catch {
        // Stream closed
      }
    })();

    // Handle process exit (async, runs in background)
    this.process.exited.then((code) => {
      this.process = null;
      this.ownsProcessGroup = false;
      this.controlClient?.close();
      this.controlClient = null;

      this.emit('exit', code, null);
    });
  }

  /**
   * Connect the control client to the app-server's WebSocket.
   * Retries connect + initialize as an atomic operation until the server is ready.
   */
  private async connectControlClient(): Promise<void> {
    const url = `ws://127.0.0.1:${this.wsPort}`;
    console.log(`[codex] Connecting control client to ${url}...`);

    this.controlClient = await this.connectAndInitialize(url, 20, 250);

    // Forward notifications from control client (used for account/login/completed)
    this.controlClient.on('notification', (method: string, params: unknown) => {
      this.emit('notification', method, params);
    });

    this.controlClient.on('error', (err: Error) => {
      this.emit('error', err);
    });

    console.log(`[codex] Control client connected`);
  }

  /**
   * Create a new WebSocket connection for a provider.
   * Performs the `initialize` handshake on the new connection.
   */
  async createConnection(): Promise<JsonRpcWsClient> {
    if (!this.process) {
      throw new Error('AppServer is not running');
    }

    return this.connectAndInitialize(`ws://127.0.0.1:${this.wsPort}`, 5, 100);
  }

  /**
   * Connect to the app-server WS and perform the initialize handshake.
   * Retries the full connect+initialize cycle to avoid leaking un-initialized connections.
   */
  private async connectAndInitialize(
    url: string,
    maxRetries: number,
    retryDelay: number,
  ): Promise<JsonRpcWsClient> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let client: JsonRpcWsClient | null = null;
      try {
        client = await JsonRpcWsClient.connect(url, {
          requestTimeout: this.config.requestTimeout,
          maxRetries: 1,
          connectTimeout: 5000,
        });

        const result = await client.request<InitializeParams, InitializeResponse>(
          'initialize',
          this.initializeParams,
        );

        assertSupportedCodex(result.userAgent);

        if (!this.initializeResult) {
          this.initializeResult = result;
        }

        return client;
      } catch (err) {
        client?.close();
        // An unsupported binary is a permanent verdict, not a readiness problem — retrying
        // it 20 times only buries the one message that explains what to do.
        if (err instanceof CodexVersionError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === 0 || (attempt + 1) % 5 === 0) {
          console.warn(
            `[codex] connect+initialize attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}`,
          );
        }
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }

    throw new Error(
      `Failed to connect+initialize ${url} after ${maxRetries} attempts: ${lastError?.message}`,
    );
  }

  async stop(): Promise<void> {
    if (this.controlClient) {
      this.controlClient.close();
      this.controlClient = null;
    }

    if (this.process) {
      const pid = this.process.pid;

      // Target the whole process group (negative PID) when we own it, so codex's
      // children die with it; the `setsid` leader doesn't forward signals, so
      // signaling just the leader PID would orphan the rest of the tree.
      const target = this.ownsProcessGroup ? -pid : pid;
      const signal = (sig: NodeJS.Signals) => {
        try {
          process.kill(target, sig);
        } catch {
          // Already dead / no such process group
        }
      };

      // Graceful first, then force-kill if it's still alive after a timeout.
      signal('SIGTERM');
      const exitPromise = this.process.exited;
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          signal('SIGKILL');
          resolve();
        }, 5000);
      });
      await Promise.race([exitPromise, timeoutPromise]);

      this.process = null;
      this.ownsProcessGroup = false;
    }

    if (this.tempDir) {
      try {
        await rm(this.tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.tempDir = null;
    }
  }

  get isRunning(): boolean {
    return this.process !== null && this.controlClient !== null;
  }

  getCapabilities(): InitializeResponse | null {
    return this.initializeResult;
  }

  async accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
    if (!this.controlClient) {
      throw new Error('AppServer is not running');
    }
    return this.controlClient.request<GetAccountParams, GetAccountResponse>('account/read', params);
  }

  async accountLoginStart(params: LoginAccountParams): Promise<LoginAccountResponse> {
    if (!this.controlClient) {
      throw new Error('AppServer is not running');
    }
    return this.controlClient.request<LoginAccountParams, LoginAccountResponse>(
      'account/login/start',
      params,
    );
  }

  async accountLoginCancel(params: CancelLoginAccountParams): Promise<CancelLoginAccountResponse> {
    if (!this.controlClient) {
      throw new Error('AppServer is not running');
    }
    return this.controlClient.request<CancelLoginAccountParams, CancelLoginAccountResponse>(
      'account/login/cancel',
      params,
    );
  }
}

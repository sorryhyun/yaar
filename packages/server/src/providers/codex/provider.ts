/**
 * Codex App-Server Provider (WebSocket transport).
 *
 * Uses `codex app-server` for long-running JSON-RPC communication.
 * Each provider gets its own WebSocket connection via `appServer.createConnection()`,
 * enabling true parallel execution — no turn serialization mutex needed.
 *
 * Architecture:
 * - One AppServer process shared across agents (owned by WarmPool)
 * - Each provider has its own WS connection (notifications routed per-connection)
 * - Each agent gets its own thread (via thread/start, or thread/resume on restore)
 * - Provider never stops the AppServer — WarmPool handles lifecycle
 */

import { errMessage } from '@yaar/lib/errors';
import type {
  AITransport,
  InterruptReceipt,
  StreamMessage,
  TransportOptions,
  ProviderType,
} from '../types.js';
import type { AppServer } from './app-server.js';
import type { JsonRpcWsClient } from './jsonrpc-ws-client.js';
import { mapNotification } from './message-mapper.js';
import { createInputChannel } from '../input-channel.js';
import { TurnGate } from '../turn-gate.js';
import { getOrchestratorPrompt } from '../../agents/profiles/orchestrator/index.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { buildMcpServerSet } from '../mcp-servers.js';
import { SUB_AGENT_MCP_SERVER } from '../../agents/profiles/sub-agent.js';
import type {
  ThreadStartParams,
  ThreadStartResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
} from './types.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('codex:provider');

/**
 * How long a steer waits for `turn/start` to answer with the turn id it must
 * name. One RPC round trip on a local socket; past this the turn is not
 * starting, and the caller is better served by the fresh turn it falls back to.
 */
const STEER_TURN_START_MS = 10_000;

/** The notification that ends a turn, as the mapper typed it — the only place that decides. */
function endsTurn(message: StreamMessage): boolean {
  return message.type === 'complete' || message.type === 'error';
}

interface ThreadSession {
  threadId: string;
  systemPrompt: string;
  /** Model this thread was started with (undefined = app-server default). */
  model?: string;
  /** Sorted MCP namespaces this thread was scoped to (undefined = unrestricted). */
  mcpScope?: string;
}

/** Per-thread MCP server override map: namespace → server config. */
type McpServerOverride = Record<
  string,
  { url: string; bearer_token_env_var: string; http_headers?: Record<string, string> }
>;

/**
 * Which MCP namespaces a turn's thread connects to.
 *
 * Codex cannot filter *tools* per thread the way Claude's `allowedTools` does, so callers
 * that only want to narrow within a namespace pass `undefined` and get the whole surface
 * (`app-task-processor.ts` does this for app agents). But it can filter which *servers* a
 * thread connects to at all, and that is enough to carry the one containment that matters:
 * a sub-agent's turn names `mcp__subagent__*` and nothing else, so it reaches its own app's
 * iframe and no YAAR verb. Without this filter its thread got the full set — the profile's
 * allowlist was honored on the Claude path (`claude/sdk-options.ts` derives the same way
 * from `allowedTools`) and silently ignored here, which is the whole reason it exists.
 *
 * The unfiltered case still drops `subagent`, because that namespace's tool list is a pure
 * function of *who is calling* — `registerSubAgentTools` registers nothing for anyone but a
 * sub-agent, and a sub-agent always arrives with an allowlist. Attaching it to a monitor or
 * app agent therefore produced an empty server that advertises a `tools` capability it has
 * no handler for, which codex reports as `-32601 Method not found` and marks failed. Every
 * codex thread carried one such dead connection.
 */
function codexServerFilter(allowedTools: string[] | undefined): (name: string) => boolean {
  if (!allowedTools) return (name) => name !== SUB_AGENT_MCP_SERVER;
  const needed = new Set<string>();
  for (const tool of allowedTools) {
    const match = tool.match(/^mcp__(\w+)__/);
    if (match) needed.add(match[1]);
  }
  return (name) => needed.has(name);
}

export class CodexProvider implements AITransport {
  readonly name = 'codex';
  readonly providerType: ProviderType = 'codex';
  // `config/system-prompt.txt` wins over the built-in prompt, as it does for Claude. Read once
  // per instance: `needsNewThread` compares this string, so it must not vary between turns.
  readonly systemPrompt = getOrchestratorPrompt();

  private appServer: AppServer | null;
  private client: JsonRpcWsClient | null = null;
  private currentSession: ThreadSession | null = null;

  /**
   * The running query's abort, so interrupt() can stop its read loop. Minted per
   * query and cleared by that query on the way out — only if it is still the one
   * installed, since the idle-recovery retry runs a nested query() that installs
   * its own.
   */
  private turnAbort: AbortController | null = null;

  /**
   * The in-flight turn, keyed by the id `turn/start` returned — what `turn/steer`
   * names as `expectedTurnId` and `turn/interrupt` names as `turnId`.
   */
  private readonly turns = new TurnGate<string>();

  // Guards the idle-recovery retry in query() so a persistently-broken thread
  // can't recurse forever (resume fails → new thread → turn/start fails → …).
  private recovering = false;

  /** @param appServer - The shared AppServer (owned by WarmPool, not this provider). */
  constructor(appServer: AppServer) {
    this.appServer = appServer;
  }

  getSessionId(): string | null {
    return this.currentSession?.threadId ?? null;
  }

  /**
   * Establish a dedicated WebSocket connection to the app-server.
   * Called by WarmPool during provider creation.
   */
  async warmup(): Promise<boolean> {
    if (!this.appServer?.isRunning) return false;

    try {
      this.client = await this.appServer.createConnection();
      return true;
    } catch (err) {
      log.error('failed to establish WS connection during warmup', { err });
      return false;
    }
  }

  async isAvailable(): Promise<boolean> {
    return (this.appServer?.isRunning ?? false) && (this.client?.isConnected ?? false);
  }

  /**
   * Ensure a live WS connection to the app-server, re-establishing one if it
   * dropped while the agent was idle. The connection is per-provider plumbing;
   * threads live in the shared app-server process, so a fresh connection can
   * resume/continue a thread the previous one created — no context is tied to
   * the socket. Returns false only when the app-server itself is gone.
   */
  private async ensureClient(): Promise<boolean> {
    if (this.client?.isConnected) return true;
    if (!this.appServer?.isRunning) return false;
    try {
      // Reap the dead client before replacing it so its socket/timers are freed.
      this.client?.close();
      this.client = await this.appServer.createConnection();
      return true;
    } catch (err) {
      log.error('failed to re-establish WS connection', { err });
      return false;
    }
  }

  async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
    const abort = new AbortController();
    this.turnAbort = abort;

    try {
      // Reconnect a socket that dropped while idle rather than failing the turn.
      if (!this.appServer?.isRunning || !(await this.ensureClient())) {
        yield { type: 'error', error: 'AppServer or WS connection is not available' };
        return;
      }

      // Capture local references so dispose() doesn't crash the finally block.
      const client = this.client!;

      const threadCreated = await this.ensureThread(options);
      if (threadCreated) {
        yield { type: 'text', sessionId: this.currentSession!.threadId };
      }

      // Stamp monitorId so actions emitted during this turn carry the correct origin
      // when the MCP boundary can't resolve one from the agent (see resolveMonitorId).
      // Agent identity needs no such fallback: buildMcpScope bakes this agent's token
      // into the thread's MCP header, so every tool call self-identifies.
      if (options.monitorId) {
        actionEmitter.setCurrentMonitor(options.monitorId);
      }

      // Local per query, so a nested recovery query cannot read this one's
      // notifications. Turn end is the mapper's call alone: the channel closes
      // behind the first message it typed terminal. The loop used to decide it
      // again from the raw method name, and the two copies disagreed on an
      // `error` the app-server was about to retry (see `errors.ts`).
      const inbox = createInputChannel<StreamMessage>({ isLast: endsTurn });
      const notificationHandler = (method: string, params: unknown) => {
        const message = mapNotification(method, params);
        if (message) inbox.push(message);
      };
      client.on('notification', notificationHandler);

      // interrupt() aborts; closing the inbox is what wakes a read parked on it.
      const closeInbox = () => inbox.close();
      if (abort.signal.aborted) closeInbox();
      else abort.signal.addEventListener('abort', closeInbox, { once: true });

      // Handle server-initiated requests (approval dialogs)
      const serverRequestHandler = (id: number, method: string, params: unknown) => {
        this.handleServerRequest(client, id, method, params).catch((err) => {
          log.error('failed to handle server request', { method, err });
          client.respondError(id, -32000, err instanceof Error ? err.message : 'Internal error');
        });
      };
      client.on('server_request', serverRequestHandler);

      const turn = this.turns.begin();
      try {
        const input: Array<
          { type: 'text'; text: string; text_elements: never[] } | { type: 'image'; url: string }
        > = [{ type: 'text', text: prompt, text_elements: [] }];

        if (options.images && options.images.length > 0) {
          for (const imageDataUrl of options.images) {
            input.push({ type: 'image', url: imageDataUrl });
          }
        }

        // Start the turn; its id is what steer and interrupt name.
        const turnResult = await client.request<TurnStartParams, TurnStartResponse>('turn/start', {
          threadId: this.currentSession!.threadId,
          input,
        });
        turn.start(turnResult.turn.id);

        for await (const message of inbox.iterable) {
          // Whatever was queued when the stop came is the stopped turn's tail.
          if (abort.signal.aborted) break;
          yield message;
        }
      } finally {
        client.off('notification', notificationHandler);
        client.off('server_request', serverRequestHandler);
        abort.signal.removeEventListener('abort', closeInbox);
        actionEmitter.clearCurrentMonitor();
        turn.end();
      }
    } catch (err) {
      // Session recovery: the app-server evicted our idle thread from memory (or
      // the connection it lived behind dropped), so turn/start reported an
      // invalid thread. The thread is still persisted as a rollout on disk —
      // resume it by id so the conversation history survives, instead of nulling
      // it and silently starting a blank thread. `recovering` bounds this to a
      // single retry: if the resume itself fails, ensureThread falls back to a
      // fresh thread and this second failure surfaces as an error.
      if (
        err instanceof Error &&
        !this.recovering &&
        (err.message.includes('thread') || err.message.includes('invalid'))
      ) {
        const lostThreadId = this.currentSession?.threadId;
        this.currentSession = null;
        this.recovering = true;
        try {
          const retryOptions: TransportOptions = lostThreadId
            ? { ...options, resumeThread: true, sessionId: lostThreadId }
            : options;
          yield* this.query(prompt, retryOptions);
        } finally {
          this.recovering = false;
        }
        return;
      }

      yield { type: 'error', error: errMessage(err) };
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
  }

  async steer(content: string): Promise<boolean> {
    if (!this.client?.isConnected || !this.currentSession?.threadId) return false;

    // The agent counts as running from before `turn/start` has answered, and
    // `turn/steer` must name the id that answer carries (see `turn-gate.ts`).
    const target = await this.turns.waitForStart(STEER_TURN_START_MS);
    if (!target.ok) return false;

    // Re-read after the wait: dispose() may have taken both away meanwhile.
    const client = this.client;
    const threadId = this.currentSession?.threadId;
    if (!client?.isConnected || !threadId) return false;

    try {
      await client.request<TurnSteerParams, TurnSteerResponse>('turn/steer', {
        threadId,
        input: [{ type: 'text', text: content, text_elements: [] }],
        expectedTurnId: target.value,
      });
      return true;
    } catch (err) {
      log.warn('turn/steer failed', { err });
      return false;
    }
  }

  /**
   * Interrupt the in-flight turn, and don't return until app-server has said so.
   *
   * The `turn/interrupt` request used to be fired and forgotten, so this
   * resolved while the turn was still winding down and the caller reported a
   * stop it had not observed. The local abort below is unconditional either
   * way — it is what unblocks *our* read loop — but whether the model stopped
   * is app-server's answer to give, so we wait for it and say which happened.
   */
  async interrupt(): Promise<InterruptReceipt> {
    const threadId = this.currentSession?.threadId;
    const turnId = this.turns.current;
    const canAsk = !!this.client?.isConnected && !!threadId && !!turnId;

    let outcome: InterruptReceipt['outcome'] = canAsk ? 'acknowledged' : 'idle';
    if (canAsk) {
      try {
        await this.client!.request<TurnInterruptParams, TurnInterruptResponse>('turn/interrupt', {
          threadId: threadId!,
          turnId: turnId!,
        });
      } catch (err) {
        // The turn is still stopped locally — we abort below — but nothing
        // confirmed the model stopped, so this is not a clean acknowledgement.
        log.warn('turn/interrupt failed', { err });
        outcome = 'escalated';
      }
    }

    // The abort closes the read loop's inbox (see query()).
    this.turnAbort?.abort();
    return { outcome };
  }

  /**
   * Handle a server-initiated JSON-RPC request (e.g. approval dialogs).
   */
  private async handleServerRequest(
    client: JsonRpcWsClient,
    id: number,
    method: string,
    params: unknown,
  ): Promise<void> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const p = params as CommandExecutionRequestApprovalParams;
        const description = p.command ?? 'unknown command';
        const title = 'Command Execution';
        const message = p.reason
          ? `${p.reason}\n\n\`${description}\``
          : `Codex wants to run:\n\n\`${description}\``;

        const approved = await actionEmitter.showPermissionDialog({
          title,
          message,
          toolName: 'codex_command',
          context: p.command ?? undefined,
        });
        client.respond(id, {
          decision: approved ? 'accept' : 'decline',
        });
        break;
      }

      case 'item/fileChange/requestApproval': {
        const p = params as FileChangeRequestApprovalParams;
        const title = 'File Change';
        const message = p.reason
          ? p.reason
          : `Codex wants to modify files${p.grantRoot ? ` under ${p.grantRoot}` : ''}`;

        const approved = await actionEmitter.showPermissionDialog({
          title,
          message,
          toolName: 'codex_file_change',
          context: p.grantRoot ?? undefined,
        });
        client.respond(id, {
          decision: approved ? 'accept' : 'decline',
        });
        break;
      }

      default:
        log.warn('unhandled server request', { method });
        client.respondError(id, -32601, `Unhandled method: ${method}`);
        break;
    }
  }

  async dispose(): Promise<void> {
    await this.interrupt();
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    // Don't stop the AppServer — it's owned by WarmPool.
    this.appServer = null;
    this.currentSession = null;
    // A query abandoned mid-turn never reaches its own `finally`; wake any steer
    // waiting on it rather than leaving it to time out.
    this.turns.reset();
  }

  /**
   * Build a per-thread `mcp_servers` override that pins the caller's identity onto
   * every YAAR MCP server as an `x-agent-token` HTTP header — a credential minted for
   * this agent alone, which the server maps back to its id (mcp/agent-tokens.ts) to
   * resolve session/monitor/window/role context.
   *
   * This is required because all Codex agents share one app-server process and one
   * HTTP MCP server: a tool call arriving over HTTP carries no inherent agent identity,
   * so without a per-thread header the server cannot tell overlapping turns apart
   * (e.g. a monitor agent spawns an app agent fire-and-forget, and the app agent
   * resolves the wrong/empty window, so its `app:command`/`app:query` fail with "no
   * active window context"). Sending the agent's *id* directly, rather than a minted
   * token, would let a model with shell access read the shared bearer token (which
   * lives in the process environment as `YAAR_MCP_TOKEN`), set the header to the
   * session agent's id, and be the session agent — a token it cannot mint or guess
   * closes that. Stamping identity per-thread means every tool call self-identifies,
   * eliminating the race at its root.
   *
   * Which namespaces it covers is {@link codexServerFilter}'s decision.
   *
   * Returns null when there is no agentId to attach, so the thread falls back to
   * the process-level server set (and the legacy global fallback).
   */
  private buildMcpScope(
    agentId?: string,
    allowedTools?: string[],
  ): {
    servers: McpServerOverride;
    signature: string;
  } | null {
    if (!agentId) return null;

    const { servers: endpoints, agentToken } = buildMcpServerSet(
      agentId,
      codexServerFilter(allowedTools),
    );
    const servers: McpServerOverride = {};
    for (const { name, url } of endpoints) {
      servers[name] = {
        url,
        bearer_token_env_var: 'YAAR_MCP_TOKEN',
        http_headers: { 'x-agent-token': agentToken! },
      };
    }
    // agentId is stable for a given provider instance, so this signature is
    // constant across that agent's turns → no needless thread churn. Including
    // it still forces a fresh thread if the provider is ever rebound to another
    // agent, keeping the header correct.
    const namespaces = endpoints.map(({ name }) => name);
    return { servers, signature: `${agentId}:${[...namespaces].sort().join(',')}` };
  }

  /**
   * Ensure the thread is set up based on transport options.
   * Handles three cases: resume a saved thread, start new, or reuse existing.
   * Returns true if a new thread was created (caller should yield sessionId).
   */
  private async ensureThread(options: TransportOptions): Promise<boolean> {
    const client = this.client!;

    // Stamp the agent's identity onto the thread's MCP servers so its tool calls
    // self-identify to the shared MCP server (see buildMcpScope).
    const scope = this.buildMcpScope(options.agentId, options.allowedTools);
    const mcpConfig = scope ? { mcp_servers: scope.servers } : undefined;
    const mcpScope = scope?.signature;

    // Case 1: Resume a saved thread
    //
    // `config` matters here for exactly the reason it does on start: a thread's MCP
    // server set is decided when the thread is (re)opened, and since the app-server process
    // declares none (see `app-server.ts`'s `spawnProcess`), a resume that omits it opens a
    // thread with zero YAAR namespaces — the agent then has no verbs at all and answers as
    // if MCP did not exist. Until the process-level set was emptied, a resumed thread
    // inherited the servers from the loaded config and the omission was invisible.
    //
    // Only applies to a *cold* resume, which is the one YAAR performs (a thread id restored
    // from a previous run's session log, on the first turn). `thread/resume` on a thread
    // this app-server already has loaded rejoins it and ignores config overrides.
    if (options.resumeThread && options.sessionId) {
      log.info('resuming thread', { threadId: options.sessionId });
      try {
        const fullParams: ThreadResumeParams = {
          threadId: options.sessionId,
          ...(mcpConfig ? { config: mcpConfig } : {}),
        };
        const result = await client.request<ThreadResumeParams, ThreadResumeResponse>(
          'thread/resume',
          fullParams,
        );
        if (result.thread.turns.length === 0) {
          log.warn('resumed thread has no turns, starting fresh instead', {
            threadId: options.sessionId,
          });
        } else {
          this.currentSession = {
            threadId: options.sessionId,
            systemPrompt: options.systemPrompt,
            model: options.model,
            mcpScope,
          };
          return true;
        }
      } catch (err) {
        log.warn('resume failed, falling back to new thread', { err });
      }
    }

    // Case 2: Need new thread (no session, system prompt, model, or MCP scope changed)
    const needsNewThread =
      !this.currentSession ||
      this.currentSession.systemPrompt !== options.systemPrompt ||
      this.currentSession.model !== options.model ||
      this.currentSession.mcpScope !== mcpScope;

    if (needsNewThread) {
      const fullParams: ThreadStartParams = {
        experimentalRawEvents: false,
        baseInstructions: options.systemPrompt,
        ...(options.model ? { model: options.model } : {}),
        ...(mcpConfig ? { config: mcpConfig } : {}),
      };
      const result = await client.request<ThreadStartParams, ThreadStartResponse>(
        'thread/start',
        fullParams,
      );
      this.currentSession = {
        threadId: result.thread.id,
        systemPrompt: options.systemPrompt,
        model: options.model,
        mcpScope,
      };
      return true;
    }

    // Case 3: Reuse existing thread (same system prompt + model + MCP scope, continuing)
    return false;
  }
}

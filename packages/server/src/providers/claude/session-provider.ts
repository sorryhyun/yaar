/**
 * Claude Session Provider.
 *
 * Uses the Claude Agent SDK to query Claude with MCP tools.
 * Sessions are created on first real query and resumed for subsequent ones.
 */

import { query as sdkQuery, type Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import { BaseTransport } from '../base-transport.js';
import type {
  EscapeGuardRecord,
  InterruptReceipt,
  StreamMessage,
  TransportOptions,
  ProviderType,
} from '../types.js';
import { mapClaudeMessage, TurnUsageTracker } from './message-mapper.js';
import { createInputChannel, type InputChannel } from './input-channel.js';
import { EscapeTripwire, escapeCorrection, escapeGuardNotice } from './escape-tripwire.js';
import { buildSDKOptions, type SDKOptionsRequest } from './sdk-options.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getClaudeSpawnArgs } from '../../config.js';
import { getOrchestratorPrompt as getSystemPrompt } from '../../agents/profiles/orchestrator/index.js';
import { type ImageMediaType, parseDataUrl } from '../../lib/image.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('ClaudeSessionProvider');

interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
}

interface TextContentBlock {
  type: 'text';
  text: string;
}

type ContentBlock = TextContentBlock | ImageContentBlock;

/** The turn-supplied half of an SDK options request; the provider fills the rest. */
type TurnOptionsRequest = Omit<
  SDKOptionsRequest,
  'defaultSystemPrompt' | 'abortController' | 'onEscapeGuard'
>;

/** Max time to hold a turn's first message while MCP servers connect. */
const MCP_CONNECT_WAIT_MS = 5000;

/**
 * How long an interrupt waits for the CLI's acknowledgement before killing the
 * process instead. A control request answered over the same pipe the turn is
 * streaming on should be near-instant; a wait this long already means the CLI
 * is not answering, and the user has been staring at a stop button since.
 */
const INTERRUPT_ACK_MS = 2000;

/**
 * How long a steer waits for its turn's own message to reach the wire. The turn
 * gates on `mcpReady` first, so the bound has to clear that with room to spare;
 * past it the turn is not starting, and the caller is better served by the fresh
 * turn it falls back to. Lands on Codex's 10s by construction.
 */
const STEER_TURN_START_MS = MCP_CONNECT_WAIT_MS + 5000;

/**
 * How many times one turn may be restarted for escape-mangled tool arguments.
 *
 * One. The correction is pushed as a user message, so a model that ignores it
 * would otherwise trip, be corrected, and trip again for as long as it kept
 * escaping — burning a turn each time. After the retry the turn is allowed to
 * run to completion however it writes its arguments, and the `PreToolUse`
 * repair hook still fixes whatever lands.
 */
const MAX_ESCAPE_RETRIES = 1;

/**
 * Resolve `promise`, or reject once `ms` have passed.
 *
 * Deliberately not a "resolve with undefined on timeout": every caller here
 * treats a missing answer as a reason to escalate, and `undefined` is already
 * the SDK's spelling for "old CLI, acknowledged with no detail". Collapsing the
 * two would make a hung control channel look like a clean stop.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Separator joining a turn's fingerprint fields. NUL cannot occur in a prompt,
 * tool name, agent id, or model, so no combination of field values can spell a
 * different combination's fingerprint and wrongly reuse its stream. Written as
 * an escape on purpose — as a raw byte it is invisible in editors and diffs and
 * does not survive formatters or copy/paste.
 */
const FINGERPRINT_SEP = '\u0000';

/**
 * A turn hit a `resume` the CLI no longer knows — the logged thread was pruned,
 * or the id came from another machine. Both turn paths retry without resume;
 * they differ in what they must tear down first, so only the test is shared.
 */
function isStaleSessionError(mapped: StreamMessage): boolean {
  return mapped.type === 'error' && !!mapped.error?.includes('No conversation found');
}

/**
 * A long-lived streaming SDK query. The spawned CLI process and its MCP
 * connections survive across turns; each turn pushes one user message into
 * the channel and reads the stream until the SDK result message.
 */
interface PersistentSession {
  stream: ReturnType<typeof sdkQuery>;
  channel: InputChannel;
  /** Prompt/tools/model identity — a change forces a reopen (with resume). */
  fingerprint: string;
  /** Resolves once every configured MCP server is connected (bounded wait). */
  mcpReady: Promise<void>;
  /** The controller bound to this stream's process. */
  abortController: AbortController;
  /** Session id this stream was opened to resume (undefined = fresh). */
  openedWithResume: string | undefined;
  /** Turns pushed so far — a virgin stream can still be swapped for a resume. */
  turnsProcessed: number;
  /**
   * Identifies the in-flight turn. Codex steers by naming an `expectedTurnId`,
   * so a steer that lost the race is refused by app-server rather than absorbed
   * into whatever runs next; the CLI exposes no turn id, so this counter is the
   * local stand-in. Only ever compared for equality.
   */
  turnId: number;
  /** Resolves once this turn's own message is on the wire; null while idle. */
  turnStarted: Promise<void> | null;
  busy: boolean;
}

export class ClaudeSessionProvider extends BaseTransport {
  readonly name = 'claude';
  readonly providerType: ProviderType = 'claude';
  readonly systemPrompt: string;

  private sessionId: string | null = null;
  private persistentSession: PersistentSession | null = null;

  constructor() {
    super();
    this.systemPrompt = getSystemPrompt();
  }

  async isAvailable(): Promise<boolean> {
    return this.isCliAvailable(...getClaudeSpawnArgs());
  }

  /**
   * Get SDK options for queries. Binds a fresh abort controller to the process
   * the resulting options will spawn (see sdk-options.ts for the options).
   */
  private getSDKOptions({ resumeSession, options }: TurnOptionsRequest): SDKOptions {
    return buildSDKOptions({
      resumeSession,
      options,
      defaultSystemPrompt: this.systemPrompt,
      abortController: this.createAbortController(),
      onEscapeGuard: (record) => this.escapeGuardQueue.push(record),
    });
  }

  /**
   * Escape-guard records waiting to be put on the message stream.
   *
   * The `PreToolUse` repair hook fires inside an SDK callback, off the read
   * loop, and has nowhere to yield to; the loop drains this on its next pass.
   * A record that outlives its turn is still worth reporting — it describes a
   * tool call that really was repaired — so the queue is not cleared between
   * turns, only by draining.
   */
  private escapeGuardQueue: EscapeGuardRecord[] = [];

  /** Turn queued escape-guard records into notices, oldest first. */
  private *drainEscapeGuards(): Generator<StreamMessage> {
    while (this.escapeGuardQueue.length > 0) {
      yield escapeGuardNotice(this.escapeGuardQueue.shift()!);
    }
  }

  /**
   * Adopt the session id the SDK reports, unless the caller pinned one — a
   * pinned id is the conversation we were told to speak into, not one to learn.
   */
  private captureSessionId(msg: unknown, options: TransportOptions): void {
    if (msg && typeof msg === 'object' && 'session_id' in msg && msg.session_id) {
      if (!options.sessionId) {
        this.sessionId = msg.session_id as string;
      }
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Inject a message into the turn that is running *now*.
   *
   * Deliberately not `Query.streamInput()`, though that is the SDK's own name
   * for this. It drains the iterable it is handed and then calls
   * `transport.endInput()` — ending the CLI's stdin. For a one-shot process that
   * is right: there is nothing more to send. Here the process is shared by every
   * later turn and fed by a channel that never closes (`input-channel.ts`), so a
   * single steer closed stdin under the whole session and the CLI exited at the
   * end of the turn, costing the warm process and its MCP connections. The close
   * is unconditional for us — the SDK defers it only when the query
   * `hasBidirectionalNeeds()` (SDK-side MCP transports, hooks, `canUseTool`) and
   * every YAAR MCP server is `type: 'http'`. Pushing into the channel the SDK is
   * already draining is the same code path to the same stdin write, minus the
   * close.
   *
   * The two guards are Codex's, transplanted, and each closes a way this could
   * land somewhere other than the turn the caller meant:
   *
   * 1. **Wait for the turn to start.** `runPersistentTurn` marks itself busy
   *    before gating on `mcpReady`, so there is a real window in which a steer
   *    would be written *ahead* of the message it is meant to steer — the
   *    conversation would read in the wrong order. Codex waits on
   *    `turnReadyPromise` for the same race.
   * 2. **Re-check identity after the wait.** A turn that ended while we waited
   *    would otherwise take our message as the *next* turn's opening line.
   *    `turnId` is the `expectedTurnId` analogue; the session identity check
   *    catches a stream closed and reopened underneath us.
   *
   * A fork's one-shot process is refused outright: it has no channel, and its
   * prompt iterable has already completed. The caller's fallback — a fresh turn
   * — is the only honest answer there.
   */
  async steer(content: string): Promise<boolean> {
    const session = this.persistentSession;
    if (!session || !session.busy) return false;

    const turnId = session.turnId;
    const started = session.turnStarted;
    if (started) {
      try {
        await withDeadline(started, STEER_TURN_START_MS);
      } catch {
        log.warn('steer: turn never started; not steering');
        return false;
      }
    }

    if (this.persistentSession !== session || !session.busy || session.turnId !== turnId) {
      return false;
    }

    session.channel.push({
      type: 'user',
      message: { role: 'user', content },
    });
    return true;
  }

  async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
    // Determine which session to resume
    // Priority: options.sessionId > this.sessionId (warmed up)
    const resumeSession = options.sessionId ?? this.sessionId ?? undefined;
    log.debug('query', {
      optionsSessionId: options.sessionId,
      providerSessionId: this.sessionId,
      resumeSession,
    });

    const messageContent = this.buildMessageContent(prompt, options);

    yield* this.executeQuery(messageContent, resumeSession, options);
  }

  private buildMessageContent(prompt: string, options: TransportOptions): string | ContentBlock[] {
    let messageContent: string | ContentBlock[] = prompt;

    log.debug('building message content', { images: options.images?.length ?? 0 });
    if (options.images && options.images.length > 0) {
      const contentBlocks: ContentBlock[] = [];

      for (const dataUrl of options.images) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          // Media type and size only. This used to log the first 50 chars of the image's
          // data URL, which is payload however short the slice.
          log.debug('adding image block', {
            mediaType: parsed.mediaType,
            dataLength: parsed.data.length,
          });
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mediaType,
              data: parsed.data,
            },
          });
        } else {
          log.warn('failed to parse image data URL', { urlChars: dataUrl.length });
        }
      }

      contentBlocks.push({
        type: 'text',
        text: prompt,
      });

      log.debug('using multimodal prompt', { contentBlocks: contentBlocks.length });
      messageContent = contentBlocks;
    }

    return messageContent;
  }

  private async *executeQuery(
    messageContent: string | ContentBlock[],
    resumeSession: string | undefined,
    options: TransportOptions,
  ): AsyncIterable<StreamMessage> {
    // Stamp monitorId so actions emitted during this turn carry the correct
    // origin (mirrors Codex provider behavior).
    if (options.monitorId) {
      actionEmitter.setCurrentMonitor(options.monitorId);
    }
    try {
      if (options.forkSession && resumeSession) {
        // Forks get a dedicated one-shot process; the forked conversation goes
        // persistent from its own next turn.
        yield* this.runOneShotTurn(messageContent, resumeSession, options);
      } else {
        yield* this.runPersistentTurn(messageContent, resumeSession, options);
      }
    } finally {
      actionEmitter.clearCurrentMonitor();
    }
  }

  /** Prompt/tools/model identity of a turn — decides persistent-stream reuse. */
  private turnFingerprint(options: TransportOptions): string {
    return [
      options.systemPrompt ?? this.systemPrompt,
      (options.allowedTools ?? []).join(','),
      options.agentId ?? '',
      options.model ?? '',
    ].join(FINGERPRINT_SEP);
  }

  /**
   * Run one turn on the provider's long-lived streaming session, creating it
   * on first use. The CLI process and its MCP connections survive between
   * turns, so later turns skip both the spawn and the MCP handshake. A change
   * in prompt/tools/model closes the stream and reopens it with `resume`,
   * carrying the conversation over.
   */
  private async *runPersistentTurn(
    messageContent: string | ContentBlock[],
    resumeSession: string | undefined,
    options: TransportOptions,
  ): AsyncIterable<StreamMessage> {
    const fingerprint = this.turnFingerprint(options);
    const existing = this.persistentSession;
    // A turn that targets a conversation this stream doesn't carry (e.g.
    // restoring a logged thread) needs a fresh process opened with resume. A
    // virgin (prewarmed) stream carries only what it was opened to resume.
    const wrongConversation = existing
      ? existing.turnsProcessed === 0
        ? resumeSession !== existing.openedWithResume
        : options.sessionId !== undefined &&
          this.sessionId !== null &&
          options.sessionId !== this.sessionId
      : false;
    if (existing && (existing.busy || existing.fingerprint !== fingerprint || wrongConversation)) {
      await this.closePersistentSession();
    }
    if (!this.persistentSession) {
      const sdkOptions = this.getSDKOptions({ resumeSession, options });
      this.openPersistentSession(sdkOptions, fingerprint, resumeSession);
    }

    const session = this.persistentSession!;
    session.busy = true;
    session.turnId++;
    // Steering waits on this rather than on `busy`: busy is true from here, but
    // the turn's own message is not on the wire until after the MCP gate below.
    let markTurnStarted!: () => void;
    session.turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    let messageCount = 0;
    // One tracker per turn — the stream outlives the turn, the accumulator must not.
    const turnUsage = new TurnUsageTracker();
    // Per-turn too: block indices restart with each assistant message.
    const tripwire = new EscapeTripwire();
    let escapeRetries = 0;
    // Set between "we interrupted" and "the interrupted turn's terminal arrived",
    // which is the one result message this turn must swallow rather than yield.
    let awaitingEscapeRetry = false;
    try {
      await session.mcpReady;
      session.turnsProcessed++;
      session.channel.push({
        type: 'user',
        message: { role: 'user', content: messageContent },
      });
      markTurnStarted();

      for (;;) {
        const { value: msg, done } = await session.stream.next();
        if (done) {
          // Process exited (crash or abort) — the stream is gone.
          await this.closePersistentSession();
          // An escape-retry that lost its stream has already had this turn's
          // terminal swallowed, so returning here would leave the caller with
          // no completion at all. Resend on a fresh stream instead: the
          // original message is still the one that needs answering.
          if (awaitingEscapeRetry && !session.abortController.signal.aborted) {
            log.warn('stream ended during escape retry; resending fresh');
            yield* this.executeQuery(messageContent, this.sessionId ?? undefined, options);
            return;
          }
          if (messageCount === 0 && !session.abortController.signal.aborted) {
            log.warn('persistent stream ended before responding; retrying fresh');
            this.sessionId = null;
            yield* this.executeQuery(messageContent, undefined, options);
          }
          return;
        }
        messageCount++;
        if (session.abortController.signal.aborted) break;

        // Anything the repair hook fixed since the last pass. Drained here
        // rather than at the trip site because the hook fires on its own
        // schedule, between reads.
        yield* this.drainEscapeGuards();

        this.captureSessionId(msg, options);

        // Cancel a tool call whose arguments are being written as escape
        // sequences, before the rest of them are generated. The correction is
        // pushed straight into the channel, so the retry runs on this same
        // stream and stays one turn from the caller's point of view — which is
        // why the interrupted turn's terminal is swallowed below rather than
        // yielded. `stream.interrupt()` rather than `this.interrupt()`: the
        // latter aborts the controller and takes the process down on timeout,
        // and the process is exactly what the retry needs.
        if (
          !awaitingEscapeRetry &&
          escapeRetries < MAX_ESCAPE_RETRIES &&
          (msg as { type?: string }).type === 'stream_event'
        ) {
          const tripped = tripwire.observe((msg as { event?: unknown }).event);
          if (tripped) {
            escapeRetries++;
            awaitingEscapeRetry = true;
            log.warn('escaped-text tripwire; restarting turn', { tool: tripped.toolName });
            // Before the interrupt: this notice carries the only record that
            // the cancelled call ever happened, and the turn is about to be
            // torn down. See `EscapeGuardRecord`.
            yield escapeGuardNotice(tripped);
            void session.stream.interrupt().catch(() => {
              // An interrupt the CLI never acknowledged still leaves the pushed
              // correction queued; the turn either ends on its own or the outer
              // abort path takes it. Nothing useful to do here.
            });
            session.channel.push({
              type: 'user',
              message: { role: 'user', content: escapeCorrection(tripped.toolName) },
            });
            continue;
          }
        }

        const mapped = mapClaudeMessage(msg, turnUsage);
        if (!mapped) continue;

        // Detect stale session error and retry without resume
        if (resumeSession && isStaleSessionError(mapped)) {
          log.warn('stale session; retrying without resume', { resumeSession });
          this.sessionId = null;
          await this.closePersistentSession();
          yield* this.executeQuery(messageContent, undefined, options);
          return;
        }

        // The interrupted turn's own terminal. Yielding it would end the turn
        // in the UI while the correction we already pushed is about to start
        // answering on the same stream.
        if (awaitingEscapeRetry && (mapped.type === 'complete' || mapped.type === 'error')) {
          awaitingEscapeRetry = false;
          tripwire.reset();
          continue;
        }

        yield mapped;
        // 'complete'/'error' map the SDK result message: the turn is over but
        // the stream stays open for the next one.
        if (mapped.type === 'complete' || mapped.type === 'error') {
          log.info('turn finished', { messages: messageCount });
          return;
        }
      }

      // Aborted mid-turn — the controller is taking the process down with it.
      await this.closePersistentSession();
    } catch (err) {
      await this.closePersistentSession();
      if (!this.isAbortError(err)) {
        yield this.createErrorMessage(err);
      }
    } finally {
      session.busy = false;
      session.turnStarted = null;
      // Wake a steer still waiting on a turn that ended, or that never started
      // at all (the MCP gate threw). It re-checks and refuses rather than
      // holding the caller for the full deadline.
      markTurnStarted();
    }
  }

  private openPersistentSession(
    sdkOptions: SDKOptions,
    fingerprint: string,
    openedWithResume: string | undefined,
  ): void {
    const channel = createInputChannel();
    const stream = sdkQuery({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK expects SDKUserMessage but accepts partial
      prompt: channel.iterable as AsyncIterable<any>,
      options: sdkOptions,
    });
    this.persistentSession = {
      stream,
      channel,
      fingerprint,
      // The CLI no longer waits for HTTP MCP servers before starting a turn in
      // stream-json mode — an ungated first turn runs tool-less and the agent
      // narrates the verb calls it cannot make. Later turns resolve instantly.
      mcpReady: this.waitForMcpConnected(stream, sdkOptions),
      abortController: sdkOptions.abortController ?? new AbortController(),
      openedWithResume,
      turnsProcessed: 0,
      turnId: 0,
      turnStarted: null,
      busy: false,
    };
  }

  /**
   * Pre-open the persistent stream with the exact options the first turn will
   * use (see AgentSession.prewarm). By the time the user sends their first
   * message, the process is up and its MCP servers are connected.
   */
  async prewarm(options: TransportOptions): Promise<void> {
    if (this.persistentSession) return;
    const resumeSession = options.sessionId ?? this.sessionId ?? undefined;
    const sdkOptions = this.getSDKOptions({ resumeSession, options });
    this.openPersistentSession(sdkOptions, this.turnFingerprint(options), resumeSession);
    await this.persistentSession!.mcpReady;
    log.info('prewarmed persistent stream (MCP connected)');
  }

  /** Tear down the long-lived stream; conversation context survives via resume. */
  private async closePersistentSession(): Promise<void> {
    const session = this.persistentSession;
    if (!session) return;
    this.persistentSession = null;
    session.channel.close();
    session.abortController.abort();
    try {
      await session.stream.return(undefined);
    } catch {
      // Teardown errors of a dying process are irrelevant.
    }
  }

  /** Dedicated single-turn process, used for session forks. */
  private async *runOneShotTurn(
    messageContent: string | ContentBlock[],
    resumeSession: string,
    options: TransportOptions,
  ): AsyncIterable<StreamMessage> {
    const sdkOptions = this.getSDKOptions({ resumeSession, options });
    sdkOptions.forkSession = true;

    // Hold the user message until MCP servers connect (see openPersistentSession).
    let releaseMcpGate!: () => void;
    const mcpGate = new Promise<void>((resolve) => {
      releaseMcpGate = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptInput = (async function* (): AsyncGenerator<any> {
      await mcpGate;
      yield {
        type: 'user',
        message: { role: 'user', content: messageContent },
      };
    })();

    try {
      const stream = sdkQuery({ prompt: promptInput, options: sdkOptions });
      void this.waitForMcpConnected(stream, sdkOptions).finally(releaseMcpGate);
      let messageCount = 0;
      const turnUsage = new TurnUsageTracker();

      for await (const msg of stream) {
        messageCount++;
        if (this.isAborted()) break;

        this.captureSessionId(msg, options);

        const mapped = mapClaudeMessage(msg, turnUsage);
        if (mapped) {
          // Detect stale session error and retry without resume
          if (isStaleSessionError(mapped)) {
            log.warn('stale session; retrying without resume', { resumeSession });
            this.sessionId = null;
            yield* this.executeQuery(messageContent, undefined, options);
            return;
          }
          yield mapped;
        }
      }

      log.info('fork turn finished', { messages: messageCount });
    } catch (err) {
      if (this.isAbortError(err)) {
        return;
      }
      yield this.createErrorMessage(err);
    }
  }

  /**
   * Wait (bounded) until every configured MCP server reports connected
   * (~700ms for the local HTTP servers), so a turn's first message is only
   * sent once its tools exist. A failed server or timeout falls through
   * rather than stalling the turn.
   */
  private async waitForMcpConnected(
    stream: ReturnType<typeof sdkQuery>,
    sdkOptions: SDKOptions,
  ): Promise<void> {
    const expected = Object.keys(sdkOptions.mcpServers ?? {});
    if (expected.length === 0) return;
    const signal = sdkOptions.abortController?.signal;
    const deadline = Date.now() + MCP_CONNECT_WAIT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) return;
      try {
        const statuses = await stream.mcpServerStatus();
        const byName = new Map(statuses.map((s) => [s.name, s.status]));
        if (expected.every((name) => byName.get(name) === 'connected')) return;
        // A failed server won't recover within this wait — don't burn it.
        const failed = expected.filter((name) => byName.get(name) === 'failed');
        if (failed.length > 0) {
          log.warn('MCP server(s) failed to connect', { servers: failed.join(', ') });
          return;
        }
      } catch {
        // Control channel not up yet — keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    log.warn('MCP server(s) still pending; starting turn without them', {
      waitedMs: MCP_CONNECT_WAIT_MS,
    });
  }

  /**
   * Interrupt the in-flight turn, and don't return until it is actually stopped.
   *
   * On the persistent stream this is a control request whose *receipt* is the
   * whole point (`SDKControlInterruptResponse`): `still_queued` names async user
   * messages that, in the SDK's words, "WILL run unless cancelled first". This
   * used to be `void stream.interrupt().catch(...)` — fire-and-forget — so the
   * receipt was discarded and only a rejection was noticed. The turn was
   * reported stopped while the CLI worked through whatever it had kept, which is
   * exactly what "it says stopped but it's still going" looks like from outside.
   *
   * Three escalations, all ending in `closePersistentSession()` because killing
   * the process is the only stop this provider owns that cannot be argued with:
   * leftover queued work, an acknowledgement that never came, and a rejection.
   * An empty `still_queued` is not proof of quiet — messages enqueued without a
   * uuid are never listed — but it is the strongest signal the CLI offers, and
   * the alternative is killing a healthy warm process after every stop.
   *
   * An *idle* session is closed rather than aborted. `this.abortController` is
   * the same controller the open stream was built with (`getSDKOptions` mints
   * it, `openPersistentSession` stores it), so `super.interrupt()` here would
   * kill a prewarmed process while leaving `persistentSession` pointing at it —
   * and the next turn would reuse that corpse, push a message into a dead
   * channel, and return no answer at all.
   */
  async interrupt(): Promise<InterruptReceipt> {
    const session = this.persistentSession;
    if (!session) return super.interrupt();
    if (!session.busy) {
      await this.closePersistentSession();
      return { outcome: 'idle' };
    }

    try {
      const receipt = await withDeadline(session.stream.interrupt(), INTERRUPT_ACK_MS);
      const stillQueued = receipt?.still_queued ?? [];
      if (stillQueued.length === 0) return { outcome: 'acknowledged' };
      log.warn('interrupt left messages queued; closing the stream', {
        stillQueued: stillQueued.length,
      });
      await this.closePersistentSession();
      return { outcome: 'escalated', stillQueued };
    } catch (err) {
      log.warn('control interrupt failed; killing process', { err });
      await this.closePersistentSession();
      return { outcome: 'escalated' };
    }
  }

  async dispose(): Promise<void> {
    await this.closePersistentSession();
    this.sessionId = null;
    await super.dispose();
  }
}

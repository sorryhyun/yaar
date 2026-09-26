/**
 * Claude Session Provider.
 *
 * Uses the Claude Agent SDK to query Claude with MCP tools.
 * Sessions are created on first real query and resumed for subsequent ones.
 */

import {
  query as sdkQuery,
  type HookCallback,
  type Options as SDKOptions,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { errMessage } from '@yaar/lib/errors';
import { isCliAvailable } from '../cli-probe.js';
import type {
  AITransport,
  EscapeGuardRecord,
  ExternalTurnHandlers,
  InterruptReceipt,
  RemoteControlInfo,
  StreamMessage,
  TransportOptions,
  ProviderType,
} from '../types.js';
import { mapClaudeMessage, ToolBlockBuffer, TurnUsageTracker } from './message-mapper.js';
import { createInputChannel, type InputChannel } from '../input-channel.js';
import { withDeadline } from '../deadline.js';
import { TurnGate } from '../turn-gate.js';
import { TurnRouter, type DetachedTurn } from './turn-router.js';
import { EscapeTripwire, escapeCorrection, escapeGuardNotice } from './escape-tripwire.js';
import { buildSDKOptions, type SDKOptionsRequest } from './sdk-options.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getClaudeSpawnArgs } from '../../config.js';
import { getOrchestratorPrompt as getSystemPrompt } from '../../agents/profiles/orchestrator/index.js';
import { type ImageMediaType, parseDataUrl } from '@yaar/lib/image';
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

/** A user message as YAAR writes it to the CLI's stdin (the SDK fills in `session_id`). */
interface OutgoingUserMessage {
  type: 'user';
  uuid: string;
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
}

/** The turn-supplied half of an SDK options request; the provider fills the rest. */
type TurnOptionsRequest = Omit<
  SDKOptionsRequest,
  'defaultSystemPrompt' | 'abortController' | 'onEscapeGuard'
>;

/** The SDK rejects with this when its abort controller fires — an expected stop, not a failure. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

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

/** First wait before reopening a bridged stream whose process went away; doubles per failure. */
const REMOTE_REOPEN_MS = 2000;
const REMOTE_REOPEN_MAX_MS = 60_000;

/** Own prompts remembered for the `UserPromptSubmit` hook to recognise. */
const OWN_PROMPT_LIMIT = 32;

/**
 * `Query.enableRemoteControl` — the control request Claude's IDE extensions use to put a
 * headless session on claude.ai. Present on the SDK's `Query` at runtime but not in its
 * published typings, so it is reached through this shape and checked before use.
 */
interface RemoteControlQuery {
  enableRemoteControl?(
    enabled: boolean,
    name?: string,
    opts?: { reattachSessionId?: string },
  ): Promise<{ session_url?: string; bridge_session_id?: string } | null | undefined>;
}

/** The text an SDK user message carries, as the CLI will hand it to `UserPromptSubmit`. */
function contentText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
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
  channel: InputChannel<OutgoingUserMessage>;
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
   * The YAAR turn in flight, if any — `turns.active` is what "busy" means here.
   * Codex steers by naming an `expectedTurnId`, so a steer that lost the race is
   * refused by app-server rather than absorbed into whatever runs next; the CLI
   * exposes no turn id, so the gate's own turn identity is the local stand-in.
   */
  turns: TurnGate;
  /** Where each frame the pump reads goes — see `turn-router.ts`. */
  router: TurnRouter;
  /** Set when the pump has stopped: the process is gone and the stream with it. */
  pumpDone: boolean;
  /** What stopped the pump, if it threw rather than ended. */
  pumpError: unknown;
}

export class ClaudeSessionProvider implements AITransport {
  readonly name = 'claude';
  readonly providerType: ProviderType = 'claude';
  readonly systemPrompt: string;

  private sessionId: string | null = null;
  private persistentSession: PersistentSession | null = null;
  private disposed = false;

  /**
   * Remote Control, while it is wanted. Outlives the stream: a reopen — new prompt, a
   * crashed process — reattaches to the same claude.ai conversation (`attachRemote`),
   * which is what makes the bridge belong to the agent rather than to one process.
   */
  private remote: { name?: string; info: RemoteControlInfo | null } | null = null;
  private externalHandlers: ExternalTurnHandlers | null = null;
  /** The options the stream was last opened with, so a bridged stream can reopen by itself. */
  private lastOptions: TransportOptions | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private reopenDelayMs = REMOTE_REOPEN_MS;
  /** Prompts YAAR pushed, so the prompt hook leaves them alone. Oldest first. */
  private ownPrompts: string[] = [];

  constructor() {
    this.systemPrompt = getSystemPrompt();
  }

  async isAvailable(): Promise<boolean> {
    return isCliAvailable(...getClaudeSpawnArgs());
  }

  /**
   * Get SDK options for queries. Binds a fresh abort controller to the process
   * the resulting options will spawn (see sdk-options.ts for the options); every
   * caller hands the result straight to `openPersistentSession`, which keeps that
   * controller on the session it belongs to.
   */
  private getSDKOptions({ resumeSession, options }: TurnOptionsRequest): SDKOptions {
    const sdkOptions = buildSDKOptions({
      resumeSession,
      options,
      defaultSystemPrompt: this.systemPrompt,
      abortController: new AbortController(),
      onEscapeGuard: (record) => this.escapeGuardQueue.push(record),
    });
    // Both are for Remote Control, and both are fixed when the process starts — which is
    // before anyone knows the bridge will be wanted. The replay is how a claude.ai turn's
    // question reaches YAAR (it arrives as input on the CLI's side, never on ours); the
    // hook is how that question gets the desktop context a YAAR-built prompt carries.
    // Off the bridge the hook returns at once and the replayed user frames map to nothing.
    sdkOptions.extraArgs = { ...sdkOptions.extraArgs, 'replay-user-messages': null };
    sdkOptions.hooks = {
      ...sdkOptions.hooks,
      UserPromptSubmit: [{ hooks: [this.promptHook] }],
    };
    return sdkOptions;
  }

  /**
   * Attach the monitor's desktop context to a prompt YAAR did not write.
   *
   * A YAAR turn's prompt is built with `<timeline>` and `<open_windows>` in it. A
   * claude.ai message goes from the browser into the CLI untouched, and this hook is the
   * one point where the CLI asks before the model sees it.
   */
  private readonly promptHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'UserPromptSubmit' || !this.remote) return {};
    const own = this.ownPrompts.indexOf(input.prompt);
    if (own !== -1) {
      this.ownPrompts.splice(own, 1);
      return {};
    }
    const context = this.externalHandlers?.promptContext?.();
    if (!context) return {};
    return {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
    };
  };

  /**
   * Push a user message into the stream as YAAR's own. The uuid is how the turn it starts
   * is told apart from one somebody else started (`TurnRouter`); the text is how the
   * prompt hook tells it apart from theirs.
   */
  private send(
    session: PersistentSession,
    content: string | ContentBlock[],
    uuid: string = randomUUID(),
  ): void {
    session.router.markOwn(uuid);
    if (this.remote) {
      this.ownPrompts.push(contentText(content));
      if (this.ownPrompts.length > OWN_PROMPT_LIMIT) this.ownPrompts.shift();
    }
    session.channel.push({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
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
  private captureSessionId(msg: unknown, pinnedSessionId: string | undefined): void {
    if (msg && typeof msg === 'object' && 'session_id' in msg && msg.session_id) {
      if (!pinnedSessionId) {
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
   * 1. **Wait for the turn to start.** `runPersistentTurn` begins its turn
   *    before gating on `mcpReady`, so there is a real window in which a steer
   *    would be written *ahead* of the message it is meant to steer — the
   *    conversation would read in the wrong order.
   * 2. **Re-check identity after the wait.** A turn that ended while we waited
   *    would otherwise take our message as the *next* turn's opening line.
   *    `TurnGate` refuses a wait whose turn is over or replaced; the session
   *    identity check catches a stream closed and reopened underneath us.
   */
  async steer(content: string): Promise<boolean> {
    const session = this.persistentSession;
    if (!session) return false;
    // A claude.ai turn is running and no YAAR turn is: it is the turn there is to steer.
    // The CLI folds the message into it; if the turn ends first, the message runs as a
    // turn of its own and the router hands it to the external-turn path, not to silence.
    if (!session.turns.active && session.router.detachedActive) {
      this.send(session, content);
      return true;
    }

    const target = await session.turns.waitForStart(STEER_TURN_START_MS);
    if (!target.ok) {
      if (target.reason === 'timeout') log.warn('steer: turn never started; not steering');
      return false;
    }
    if (this.persistentSession !== session) return false;

    this.send(session, content);
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
      yield* this.runPersistentTurn(messageContent, resumeSession, options);
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
    if (
      existing &&
      (existing.turns.active ||
        existing.pumpDone ||
        existing.fingerprint !== fingerprint ||
        wrongConversation)
    ) {
      await this.closePersistentSession();
    }
    this.lastOptions = options;
    if (!this.persistentSession) {
      const sdkOptions = this.getSDKOptions({ resumeSession, options });
      this.openPersistentSession(sdkOptions, fingerprint, resumeSession);
    }

    const session = this.persistentSession!;
    // Steering waits for `turn.start()`, not for this: the turn is in flight from
    // here, but its own message is not on the wire until after the MCP gate below.
    const turn = session.turns.begin();
    let messageCount = 0;
    // One tracker per turn — the stream outlives the turn, the accumulator must not.
    const turnUsage = new TurnUsageTracker();
    const toolBlocks = new ToolBlockBuffer();
    // Per-turn too: block indices restart with each assistant message.
    const tripwire = new EscapeTripwire();
    let escapeRetries = 0;
    // Set between "we interrupted" and "the interrupted turn's terminal arrived",
    // which is the one result message this turn must swallow rather than yield.
    let awaitingEscapeRetry = false;
    let inbox: InputChannel<unknown> | null = null;
    try {
      await session.mcpReady;
      session.turnsProcessed++;
      const uuid = randomUUID();
      // Reading before writing: the first frame of the answer must find its reader.
      inbox = session.router.openTurn(uuid);
      this.send(session, messageContent, uuid);
      turn.start();

      for (;;) {
        const { value: msg, done } = await inbox.iterable.next();
        if (done) {
          if (session.pumpError !== undefined) throw session.pumpError;
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

        this.captureSessionId(msg, options.sessionId);

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
            this.send(session, escapeCorrection(tripped.toolName));
            continue;
          }
        }

        const mapped = mapClaudeMessage(msg as SDKMessage, turnUsage, toolBlocks);
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
      if (!isAbortError(err)) {
        yield { type: 'error', error: errMessage(err) };
      }
    } finally {
      if (inbox) session.router.closeTurn(inbox);
      // Also wakes a steer still waiting on a turn that ended, or that never
      // started at all (the MCP gate threw): it refuses rather than holding the
      // caller for the full deadline.
      turn.end();
    }
  }

  private openPersistentSession(
    sdkOptions: SDKOptions,
    fingerprint: string,
    openedWithResume: string | undefined,
  ): void {
    const channel = createInputChannel<OutgoingUserMessage>();
    const stream = sdkQuery({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK expects SDKUserMessage but accepts partial
      prompt: channel.iterable as AsyncIterable<any>,
      options: sdkOptions,
    });
    const session: PersistentSession = {
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
      turns: new TurnGate(),
      router: new TurnRouter({
        detachable: () => this.remote !== null,
        onDetached: (turn) => this.announceExternalTurn(session, turn),
      }),
      pumpDone: false,
      pumpError: undefined,
    };
    this.persistentSession = session;
    void this.pump(session);
    if (this.remote) void this.attachRemote(session);
  }

  /**
   * Read the stream for as long as the process lives, and hand each frame to its owner.
   *
   * The stream used to be read by the turn that was waiting for it, which left it unread
   * between turns — harmless while only YAAR could start one. See `turn-router.ts`.
   */
  private async pump(session: PersistentSession): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await session.stream.next();
        if (done) break;
        session.router.route(value);
      }
    } catch (err) {
      if (!isAbortError(err)) session.pumpError = err;
    } finally {
      session.pumpDone = true;
      session.router.end();
      // A process that exits under a running turn is that turn's to handle — it reads the
      // end and retries. One that exits while idle on the bridge would otherwise leave
      // claude.ai talking to nobody until the desktop's next turn happened to reopen it.
      if (this.persistentSession === session && !session.turns.active && this.remote) {
        log.warn('bridged stream ended while idle; reopening', { error: session.pumpError });
        void this.closePersistentSession();
      }
    }
  }

  /** Hand a turn nobody in YAAR started to whoever listens for them, mapped like our own. */
  private announceExternalTurn(session: PersistentSession, turn: DetachedTurn): void {
    // The stream now carries a conversation. Left at zero, the next YAAR turn would take
    // it for a virgin prewarm opened on the wrong resume, reopen it, and cut claude.ai off.
    session.turnsProcessed++;
    const handlers = this.externalHandlers;
    if (!handlers) {
      log.warn('external turn with no handler; its output is not shown in YAAR');
      return;
    }
    handlers.onTurn({ prompt: turn.prompt, messages: this.mapExternal(turn.frames) });
  }

  private async *mapExternal(frames: AsyncIterable<unknown>): AsyncIterable<StreamMessage> {
    const usage = new TurnUsageTracker();
    const toolBlocks = new ToolBlockBuffer();
    for await (const msg of frames) {
      yield* this.drainEscapeGuards();
      // The conversation is the one this stream carries; nothing pins a different one.
      this.captureSessionId(msg, undefined);
      const mapped = mapClaudeMessage(msg as SDKMessage, usage, toolBlocks);
      if (mapped) yield mapped;
    }
  }

  /**
   * Pre-open the persistent stream with the exact options the first turn will
   * use (see AgentSession.prewarm). By the time the user sends their first
   * message, the process is up and its MCP servers are connected.
   */
  async prewarm(options: TransportOptions): Promise<void> {
    if (this.persistentSession) return;
    this.lastOptions = options;
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
      // Bounded: the pump has a `next()` outstanding, and a generator's `return` can queue
      // behind it. The abort is what actually ends the process.
      await withDeadline(session.stream.return(undefined), INTERRUPT_ACK_MS);
    } catch {
      // Teardown errors of a dying process are irrelevant.
    }
    // The next turn would reopen it; on the bridge, claude.ai may be the only one talking.
    if (this.remote) this.scheduleRemoteReopen();
  }

  /**
   * Reattach a freshly opened stream to the claude.ai conversation it replaces.
   *
   * `reattachSessionId` keeps the conversation's link: the claude.ai page carries on with
   * the new process (after a reload) rather than the user being handed a new session.
   */
  private async attachRemote(session: PersistentSession): Promise<void> {
    const remote = this.remote;
    if (!remote) return;
    try {
      const info = await this.requestRemoteControl(
        session,
        true,
        remote.name,
        remote.info?.bridgeSessionId,
      );
      if (this.remote === remote) remote.info = info;
      this.reopenDelayMs = REMOTE_REOPEN_MS;
      log.info('remote control attached', { sessionUrl: info.sessionUrl });
    } catch (err) {
      log.warn('could not reattach remote control', { err });
    }
  }

  private scheduleRemoteReopen(): void {
    if (!this.remote || this.disposed || this.reopenTimer) return;
    const delay = this.reopenDelayMs;
    this.reopenDelayMs = Math.min(delay * 2, REMOTE_REOPEN_MAX_MS);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      // A turn may have reopened it in the meantime; then there is nothing to do.
      if (!this.remote || this.disposed || this.persistentSession || !this.lastOptions) return;
      const resume = this.sessionId ?? undefined;
      this.openPersistentSession(
        this.getSDKOptions({ resumeSession: resume, options: this.lastOptions }),
        this.turnFingerprint(this.lastOptions),
        resume,
      );
    }, delay);
  }

  private async requestRemoteControl(
    session: PersistentSession,
    enabled: boolean,
    name?: string,
    reattachSessionId?: string,
  ): Promise<RemoteControlInfo> {
    const stream = session.stream as unknown as RemoteControlQuery;
    if (typeof stream.enableRemoteControl !== 'function') {
      throw new Error('This Claude Agent SDK cannot enable Remote Control.');
    }
    const res = await stream.enableRemoteControl(
      enabled,
      name,
      reattachSessionId ? { reattachSessionId } : undefined,
    );
    if (!enabled) return { sessionUrl: '', bridgeSessionId: '' };
    if (!res?.session_url || !res.bridge_session_id) {
      throw new Error('Remote Control was enabled but the CLI returned no session link.');
    }
    return { sessionUrl: res.session_url, bridgeSessionId: res.bridge_session_id, name };
  }

  /**
   * Put this conversation on claude.ai. Needs the stream open (the caller prewarms); the
   * bridge then follows the agent across reopens until {@link disableRemoteControl}.
   */
  async enableRemoteControl(name?: string): Promise<RemoteControlInfo> {
    if (this.remote?.info) return this.remote.info;
    const session = this.persistentSession;
    if (!session) throw new Error('No open conversation to put on claude.ai.');
    const remote: NonNullable<typeof this.remote> = { name, info: null };
    this.remote = remote;
    try {
      remote.info = await this.requestRemoteControl(session, true, name);
      return remote.info;
    } catch (err) {
      if (this.remote === remote) this.remote = null;
      throw err;
    }
  }

  async disableRemoteControl(): Promise<void> {
    if (!this.remote) return;
    this.remote = null;
    this.ownPrompts = [];
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
    const session = this.persistentSession;
    if (!session || session.pumpDone) return;
    try {
      await withDeadline(this.requestRemoteControl(session, false), INTERRUPT_ACK_MS);
    } catch (err) {
      log.warn('could not disable remote control cleanly', { err });
    }
  }

  getRemoteControl(): RemoteControlInfo | null {
    return this.remote?.info ?? null;
  }

  setExternalTurnHandlers(handlers: ExternalTurnHandlers | null): void {
    this.externalHandlers = handlers;
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
   * An *idle* session is closed rather than aborted: aborting the controller
   * the open stream was built with would kill a prewarmed process while leaving
   * `persistentSession` pointing at it — and the next turn would reuse that
   * corpse, push a message into a dead channel, and return no answer at all.
   * With no session there is no process at all: every controller this provider
   * mints belongs to a stream, and closing the stream aborted it.
   */
  async interrupt(): Promise<InterruptReceipt> {
    const session = this.persistentSession;
    if (!session) return { outcome: 'idle' };
    if (!session.turns.active && session.router.detachedActive) {
      // A claude.ai turn is the one running. Stop it the soft way: killing the process
      // would take the bridge down with it.
      try {
        await withDeadline(session.stream.interrupt(), INTERRUPT_ACK_MS);
        return { outcome: 'acknowledged' };
      } catch (err) {
        log.warn('control interrupt of an external turn failed; killing process', { err });
        await this.closePersistentSession();
        return { outcome: 'escalated' };
      }
    }
    if (!session.turns.active) {
      // Idle on the bridge: nothing to stop, and closing would disconnect claude.ai.
      if (this.remote) return { outcome: 'idle' };
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
    this.disposed = true;
    this.remote = null;
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
    this.externalHandlers = null;
    await this.closePersistentSession();
    this.sessionId = null;
  }
}

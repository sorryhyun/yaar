/**
 * Fake #2 — an `AITransport` whose turn is a script.
 *
 * The fidelity that matters is not what the provider *says*, it is when it *stops*. In
 * production the CLI executes an MCP tool itself and the provider's stream does not
 * advance until that tool's HTTP call returns — so a turn that calls the app-protocol
 * `command` tool is genuinely parked, inside `AgentSession.handleMessage`, inside
 * `ContextPool.handleTask`, inside `routeMessage`, inside the connection's frame queue,
 * until the app answers. That stack is the bug.
 *
 * A tool step here reproduces it exactly: the generator `await`s the real handler between
 * yields. Nothing about the wait is simulated — `handleAppCommand` really calls
 * `actionEmitter.emitAppProtocolRequest`, which really creates a `PendingStore` entry,
 * which is really only settled by an `APP_PROTOCOL_RESPONSE` arriving through
 * `handlers.message()`. The script decides what the turn *does*; the production code
 * decides what happens when it does it.
 *
 * Contrast with what every existing pool test does — `mock.module('../agents/agent-session.js')`
 * with `handleMessage = mock(async () => {})`. Under that stub, "routeMessage awaits the
 * whole turn" awaits nothing, and a turn that waits on the client cannot be expressed.
 */
import type { AITransport, StreamMessage, TransportOptions } from '../../../providers/types.js';
import type { WindowStateRegistry } from '../../../session/window-state.js';
import type { SessionId } from '../../../session/types.js';
import { runWithAgentContext } from '../../../agents/agent-context.js';

/** What a scripted step gets to work with. */
export interface TurnContext {
  /** The prompt the agent was actually handed — "did the user's message get handled". */
  prompt: string;
  options: TransportOptions;
  sessionId: SessionId;
  /** The session's real registry, for handlers that take one (`handleAppCommand`). */
  windowState: WindowStateRegistry;
  /** Results of this turn's earlier tool steps, in order. */
  results: unknown[];
}

export type ScriptStep =
  | { kind: 'text'; content: string | ((ctx: TurnContext) => string) }
  | {
      kind: 'tool';
      name?: string;
      /** Awaited between yields — the stream does not advance until it settles. */
      run: (ctx: TurnContext) => Promise<unknown>;
    };

/** A turn, as a script. Receives the prompt so one script can answer several turns. */
export type TurnScript = (ctx: TurnContext) => ScriptStep[] | Promise<ScriptStep[]>;

/** One turn the provider was asked to run. */
export interface TurnRecord {
  prompt: string;
  agentId?: string;
  monitorId?: string;
}

/** One tool step that ran, and what the production handler gave back. */
export interface ToolRecord {
  name: string;
  result: unknown;
  /** Text as the agent would see it — this is what "the app said X" is asserted against. */
  text: string;
}

/**
 * Shared across every provider instance the pool acquires (one per agent), so a test
 * scripts turns and reads back what happened in one place.
 */
export class ScriptRegistry {
  /** Every turn any agent in this session ran, in the order they started. */
  readonly turns: TurnRecord[] = [];
  /** Every tool step that ran, with the real handler's answer. */
  readonly tools: ToolRecord[] = [];

  private script: TurnScript = () => [{ kind: 'text', content: 'ok' }];

  constructor(
    readonly sessionId: SessionId,
    readonly windowState: WindowStateRegistry,
  ) {}

  /** Script what a turn does. The last call wins; the script sees each turn's prompt. */
  onTurn(script: TurnScript): void {
    this.script = script;
  }

  async stepsFor(ctx: TurnContext): Promise<ScriptStep[]> {
    return this.script(ctx);
  }
}

/** MCP tool output, rendered the way the agent would read it. */
function asText(result: unknown): string {
  if (typeof result === 'string') return result;
  const content = (result as { content?: { type: string; text?: string }[] } | null)?.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`))
      .join('\n');
  }
  return JSON.stringify(result);
}

export class ScriptedProvider implements AITransport {
  readonly name = 'scripted';
  readonly providerType = 'claude' as const;
  readonly systemPrompt = '';

  private toolUseCounter = 0;

  constructor(private readonly registry: ScriptRegistry) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
    const ctx: TurnContext = {
      prompt,
      options,
      sessionId: this.registry.sessionId,
      windowState: this.registry.windowState,
      results: [],
    };
    this.registry.turns.push({
      prompt,
      agentId: options.agentId,
      monitorId: options.monitorId,
    });

    for (const step of await this.registry.stepsFor(ctx)) {
      if (step.kind === 'text') {
        const content = typeof step.content === 'function' ? step.content(ctx) : step.content;
        yield { type: 'text', content };
        continue;
      }

      const name = step.name ?? 'tool';
      const toolUseId = `harness-tool-${++this.toolUseCounter}`;
      yield { type: 'tool_use', toolName: name, toolInput: {}, toolUseId };

      // The whole point. In production the tool runs out-of-process and the stream is
      // parked on its HTTP round trip; here it runs in-process and the stream is parked
      // on its promise. Either way the turn is *stopped* until the app answers — and the
      // agent identity the handler resolves its session and monitor from is restored the
      // same way the MCP HTTP handler restores it from headers.
      const result = await runWithAgentContext(
        {
          agentId: options.agentId ?? 'harness-agent',
          sessionId: this.registry.sessionId,
          monitorId: options.monitorId,
        },
        () => step.run(ctx),
      );

      ctx.results.push(result);
      this.registry.tools.push({ name, result, text: asText(result) });
      yield { type: 'tool_result', toolName: name, toolUseId, content: asText(result) };
    }

    yield { type: 'complete' };
  }

  interrupt(): void {}

  async dispose(): Promise<void> {}
}

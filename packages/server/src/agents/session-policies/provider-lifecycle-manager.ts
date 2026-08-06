/**
 * Provider acquisition for one `AgentSession`.
 *
 * It used to also own a live `setProvider` — swap this agent's provider at runtime, on a
 * `SET_PROVIDER` frame from the client. That frame is gone, and so is the switch: it
 * changed the provider of **monitor 0's agent alone**, leaving `ContextPool.providerType`
 * (written once, in `initialize()`), every other agent, and the warm pool pointing at the
 * old one. Provider identity was owned in two places with no invariant tying them, so
 * every `providerType === 'codex'` branch downstream read stale data after a switch. The
 * documented way to choose a provider is the `PROVIDER` env var, which is decided before
 * anything holds a stale copy of the answer.
 */
import type { AITransport } from '../../providers/types.js';
import { acquireWarmProvider } from '../../providers/factory.js';
import { createSession, SessionLogger } from '../../logging/index.js';
import { ServerEventType, type ServerEvent } from '@yaar/shared';

export interface ProviderLifecycleState {
  provider: AITransport | null;
  sessionId: string | null;
  hasProcessedFirstUserTurn: boolean;
  sessionLogger: SessionLogger | null;
}

export class ProviderLifecycleManager {
  constructor(
    private readonly state: ProviderLifecycleState,
    private readonly sendEvent: (event: ServerEvent) => Promise<void>,
  ) {}

  async initialize(preWarmedProvider?: AITransport): Promise<boolean> {
    this.state.provider = preWarmedProvider ?? (await acquireWarmProvider());

    if (!this.state.provider) {
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    if (!this.state.sessionLogger) {
      const sessionInfo = await createSession(this.state.provider.name);
      this.state.sessionLogger = new SessionLogger(sessionInfo);
    }

    await this.sendEvent({
      type: ServerEventType.CONNECTION_STATUS,
      status: 'connected',
      provider: this.state.provider.name,
    });

    return true;
  }
}

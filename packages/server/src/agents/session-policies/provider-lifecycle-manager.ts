import type { AITransport, ProviderType } from '../../providers/types.js';
import {
  acquireWarmProvider,
  createProvider,
  getAvailableProviders,
} from '../../providers/factory.js';
import { createSession, SessionLogger } from '../../logging/index.js';
import type { ServerEvent } from '@yaar/shared';

export interface ProviderLifecycleState {
  provider: AITransport | null;
  sessionId: string | null;
  hasWarmSession: boolean;
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
        type: 'ERROR',
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    if (!this.state.sessionId && this.state.provider.getSessionId) {
      const warmSessionId = this.state.provider.getSessionId();
      if (warmSessionId) {
        this.state.sessionId = warmSessionId;
        this.state.hasWarmSession = true;
        console.log(`[AgentSession] Using pre-warmed session: ${warmSessionId}`);
      }
    }

    if (!this.state.sessionLogger) {
      const sessionInfo = await createSession(this.state.provider.name);
      this.state.sessionLogger = new SessionLogger(sessionInfo);
    }

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: this.state.provider.name,
    });

    return true;
  }

  async setProvider(providerType: ProviderType): Promise<void> {
    const available = await getAvailableProviders();
    if (!available.includes(providerType)) {
      await this.sendEvent({
        type: 'ERROR',
        error: `Provider ${providerType} is not available.`,
      });
      return;
    }

    if (this.state.provider) {
      await this.state.provider.dispose();
    }

    const newProvider = await createProvider(providerType);
    this.state.provider = newProvider;
    this.state.sessionId = null;
    this.state.hasWarmSession = false;
    this.state.hasProcessedFirstUserTurn = false;

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: newProvider.name,
    });
  }
}

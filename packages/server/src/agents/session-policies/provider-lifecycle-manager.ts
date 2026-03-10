import type { AITransport, ProviderType } from '../../providers/types.js';
import {
  acquireWarmProvider,
  createProvider,
  getAvailableProviders,
} from '../../providers/factory.js';
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

  async setProvider(providerType: ProviderType): Promise<void> {
    const available = await getAvailableProviders();
    if (!available.includes(providerType)) {
      await this.sendEvent({
        type: ServerEventType.ERROR,
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
    this.state.hasProcessedFirstUserTurn = false;

    await this.sendEvent({
      type: ServerEventType.CONNECTION_STATUS,
      status: 'connected',
      provider: newProvider.name,
    });
  }
}

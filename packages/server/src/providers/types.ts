/**
 * Transport layer interfaces for AI providers.
 *
 * The transport layer abstracts how we communicate with AI providers,
 * allowing different implementations (Agent SDK, Codex SDK, etc.) without
 * changing the session logic.
 */

/**
 * Available provider types.
 */
export type ProviderType = 'claude' | 'codex';

/**
 * Provider metadata for the registry.
 */
export interface ProviderInfo {
  /** Provider type identifier */
  type: ProviderType;
  /** Human-readable display name */
  displayName: string;
  /** Short description of the provider */
  description: string;
  /** Required CLI tool (if any) for availability check */
  requiredCli?: string;
  /** Required environment variables (if any) */
  requiredEnvVars?: string[];
}

/**
 * Messages streamed from the transport during a query.
 */
export interface StreamMessage {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'complete' | 'error';
  content?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  error?: string;
}

/**
 * Options passed to transport queries.
 */
export interface TransportOptions {
  systemPrompt: string;
  model?: string;
  sessionId?: string; // For session resumption, or parent session when forking
  forkSession?: boolean; // When true with sessionId, creates a fork instead of continuing
  resumeThread?: boolean; // When true with sessionId, resume via thread/resume
  images?: string[]; // Base64 data URLs for images (e.g., user drawings)
  monitorId?: string; // Which monitor originated this query (for action routing)
  agentId?: string; // Agent instance ID (for MCP header-based routing)
  allowedTools?: string[]; // Profile-specific tool subset (overrides default getToolNames())
}

/**
 * Interface that all AI transports must implement.
 */
export interface AITransport {
  /** Human-readable name */
  readonly name: string;

  /** Provider type identifier */
  readonly providerType: ProviderType;

  /** System prompt for this provider */
  readonly systemPrompt: string;

  /** Check if this transport is available */
  isAvailable(): Promise<boolean>;

  /** Start a session and return a message stream */
  query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage>;

  /** Interrupt current query */
  interrupt(): void;

  /** Clean up resources */
  dispose(): Promise<void>;

  /**
   * Optional: Inject additional input into the active turn (mid-turn steering).
   * Returns true if successfully steered, false if not supported or failed.
   */
  steer?(content: string): Promise<boolean>;

  /**
   * Optional: Get the current session/thread ID.
   */
  getSessionId?(): string | null;
}

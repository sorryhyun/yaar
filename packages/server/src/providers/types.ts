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
  /**
   * `tool_use_start` and `tool_input_delta` are the *parameter-generation* phase
   * of a call, split out from `tool_use` so a long argument doesn't render as
   * silence. `tool_use` still arrives afterwards carrying the complete, parsed
   * `toolInput` and remains the authoritative one — the two delta types are
   * additive and a provider that cannot produce them (Codex hands arguments over
   * whole) simply never does.
   */
  type:
    | 'text'
    | 'thinking'
    | 'tool_use_start'
    | 'tool_input_delta'
    | 'tool_use'
    | 'tool_result'
    | 'complete'
    | 'error';
  /**
   * Text/thinking delta — and, on `tool_input_delta`, a raw fragment of the
   * argument JSON. That fragment is display-only: it is a prefix of a JSON
   * document, so it must not be parsed. Wait for `tool_use.toolInput`.
   */
  content?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  error?: string;
  isError?: boolean;
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

  /**
   * Optional: Pre-open the provider's long-lived stream (process + MCP
   * connections) with the exact options the first turn will use, so that
   * turn starts instantly. No message is sent.
   */
  prewarm?(options: TransportOptions): Promise<void>;
}

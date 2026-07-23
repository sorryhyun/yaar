/**
 * Transport layer interfaces for AI providers — abstracts how we talk to
 * different SDKs (Agent SDK, Codex) without changing session logic.
 */

export type ProviderType = 'claude' | 'codex';

export interface ProviderInfo {
  type: ProviderType;
  displayName: string;
  description: string;
  requiredCli?: string;
  requiredEnvVars?: string[];
}

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
  /**
   * How the raw argument JSON spelled its text, recorded before JSON.parse
   * erases the distinction. `unicodeEscapes` counts `\uXXXX` spellings that
   * decoded to printable characters (valid JSON, normalized on parse);
   * `literalBackslashU` counts backslash-u sequences that survived parsing as
   * literal text in the value — the double-escape form that actually corrupts
   * payloads. Absent when the raw text had neither, or the provider hands
   * arguments over pre-parsed (Codex).
   */
  toolInputEscapes?: { unicodeEscapes: number; literalBackslashU: number };
  toolUseId?: string;
  error?: string;
  isError?: boolean;
}

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

export interface AITransport {
  readonly name: string;
  readonly providerType: ProviderType;
  readonly systemPrompt: string;

  isAvailable(): Promise<boolean>;
  query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage>;
  interrupt(): void;
  dispose(): Promise<void>;

  /**
   * Inject additional input into the active turn (mid-turn steering).
   * Returns true if successfully steered, false if not supported or failed.
   */
  steer?(content: string): Promise<boolean>;

  getSessionId?(): string | null;

  /**
   * Pre-open the provider's long-lived stream (process + MCP connections) with
   * the exact options the first turn will use, so that turn starts instantly.
   * No message is sent.
   */
  prewarm?(options: TransportOptions): Promise<void>;
}

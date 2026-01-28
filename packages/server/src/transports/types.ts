/**
 * Transport layer interfaces for AI providers.
 *
 * The transport layer abstracts how we communicate with AI providers,
 * allowing different implementations (Agent SDK, JSON-RPC, etc.) without
 * changing the session logic.
 */

export interface StreamMessage {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'complete' | 'error';
  content?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  error?: string;
}

export interface TransportOptions {
  systemPrompt: string;
  model?: string;
  sessionId?: string; // For session resumption
}

export interface AITransport {
  /** Human-readable name */
  readonly name: string;

  /** Check if this transport is available */
  isAvailable(): Promise<boolean>;

  /** Start a session and return a message stream */
  query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage>;

  /** Interrupt current query */
  interrupt(): void;

  /** Clean up resources */
  dispose(): Promise<void>;
}

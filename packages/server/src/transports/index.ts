/**
 * Transport layer exports.
 *
 * This module provides the public API for the transport layer.
 * All imports should go through this file.
 */

// Core types
export * from './types.js';

// Factory functions
export * from './factory.js';

// Base class (for creating custom transports)
export { BaseTransport } from './base-transport.js';

// Provider implementations
export {
  ClaudeTransport,
  AgentSDKTransport, // Legacy alias for ClaudeTransport
  CodexTransport,
} from './providers/index.js';

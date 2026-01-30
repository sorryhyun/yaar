/**
 * Provider layer exports.
 *
 * This module provides the public API for AI providers.
 * All imports should go through this file.
 */

// Core types
export * from './types.js';

// Factory functions
export * from './factory.js';

// Base class (for creating custom providers)
export { BaseTransport } from './base-transport.js';

// Provider implementations
export { ClaudeProvider, AgentSDKProvider, mapClaudeMessage } from './claude/index.js';
export { CodexProvider, mapNotification as mapCodexEvent } from './codex/index.js';

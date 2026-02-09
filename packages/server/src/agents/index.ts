/**
 * Agent module exports.
 *
 * This module provides all agent-related functionality:
 * - AgentSession: Individual agent session management
 * - SessionManager: Routes messages to context pool
 * - AgentLimiter: Global semaphore for agent limit enforcement
 * - ContextPool: Unified pool with dynamic role assignment
 * - ContextTape: Hierarchical conversation context management
 */

export * from './session.js';
export * from './limiter.js';
export * from './context.js';
export * from './agent-pool.js';
export * from './context-pool.js';

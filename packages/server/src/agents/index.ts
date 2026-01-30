/**
 * Agent module exports.
 *
 * This module provides all agent-related functionality:
 * - AgentSession: Individual agent session management
 * - SessionManager: Routes messages to appropriate agents
 * - AgentLimiter: Global semaphore for agent limit enforcement
 * - DefaultAgentPool: Pool for default agents
 * - WindowAgentPool: Pool for window agents
 */

export * from './session.js';
export * from './manager.js';
export * from './limiter.js';
export * from './default-pool.js';
export * from './window-pool.js';

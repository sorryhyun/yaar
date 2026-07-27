/**
 * WebSocket event types for client-server communication.
 *
 * Split by concern: `routing.ts` (type constants + queue-bypass predicates),
 * `client.ts` (Client → Server interfaces + union), `server.ts` (Server → Client
 * interfaces + union). This barrel re-exports all three so `from '../events.js'`
 * (or `@yaar/shared`) keeps working unchanged.
 */

export * from './routing.js';
export * from './client.js';
export * from './server.js';

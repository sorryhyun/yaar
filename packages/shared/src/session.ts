/**
 * Session and monitor identifiers shared between frontend and server.
 */

/** Unique session identifier. */
export type SessionId = string;

/** Monitor identifier (e.g., '0'). */
export type MonitorId = string;

/** Default monitor ID. */
export const DEFAULT_MONITOR_ID = '0';

/**
 * Maximum monitors per session.
 *
 * Shared because the server now mints monitor ids and enforces this, while the frontend
 * still hides the "add monitor" button at the cap. Two copies of the number is how the
 * client offered a monitor the server would refuse.
 */
export const MAX_MONITORS = 4;

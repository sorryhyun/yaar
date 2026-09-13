/**
 * Prefixed random id generation — one implementation for the `{prefix}-{timestamp}-{random}`
 * ids used for messages, sessions, connections, and shortcuts.
 */

/** Default length of the random suffix. */
const DEFAULT_RANDOM_LENGTH = 5;

/**
 * Build a prefixed id of the form `{prefix}-{Date.now()}-{random}`.
 *
 * @param prefix Leading segment, e.g. `'dm'` -> `'dm-1730000000000-a1b2c'`.
 * @param randomLength Length of the base36 random suffix (default 5).
 */
export function genId(prefix: string, randomLength: number = DEFAULT_RANDOM_LENGTH): string {
  const random = Math.random()
    .toString(36)
    .slice(2, 2 + randomLength);
  return `${prefix}-${Date.now()}-${random}`;
}

/**
 * Build a base36 timestamp + random stamp with no prefix, e.g. `'lq2p3f-a1b2c3'`.
 * Used where the caller composes its own id around the stamp.
 */
export function genStamp(randomLength: number = 6): string {
  const random = Math.random()
    .toString(36)
    .slice(2, 2 + randomLength);
  return `${Date.now().toString(36)}-${random}`;
}

/**
 * Type definitions for @bundled/uuid — unique ID generation.
 */

declare module '@bundled/uuid' {
  /** Generate a random UUID v4 string */
  export function v4(): string;
  /** Generate a UUID v1 (timestamp-based) string */
  export function v1(): string;
  /** Validate a UUID string */
  export function validate(uuid: string): boolean;
  /** Get version of a UUID string */
  export function version(uuid: string): number;
}

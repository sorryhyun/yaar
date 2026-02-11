/**
 * Type definitions for @bundled/clsx — class name utility.
 */

declare module '@bundled/clsx' {
  type ClassValue = string | number | boolean | null | undefined | ClassArray | ClassDictionary;
  type ClassArray = ClassValue[];
  type ClassDictionary = Record<string, boolean | null | undefined>;

  /**
   * Construct className strings conditionally.
   *
   * @example
   * clsx('foo', true && 'bar', 'baz');
   * // => 'foo bar baz'
   *
   * @example
   * clsx({ foo: true, bar: false, baz: isTrue() });
   * // => 'foo baz'
   *
   * @example
   * clsx('foo', [1 && 'bar', { baz: false, bat: null }, ['hello', ['world']]], 'cya');
   * // => 'foo bar hello world cya'
   */
  export default function clsx(...inputs: ClassValue[]): string;

  /**
   * Named export version of clsx
   */
  export function clsx(...inputs: ClassValue[]): string;
}

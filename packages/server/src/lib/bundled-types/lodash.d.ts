/**
 * Type definitions for @bundled/lodash — utility functions.
 */

declare module '@bundled/lodash' {
  // Function utilities
  export function debounce<T extends (...args: unknown[]) => unknown>(
    func: T,
    wait?: number,
    options?: { leading?: boolean; trailing?: boolean; maxWait?: number }
  ): T & { cancel(): void; flush(): void };

  export function throttle<T extends (...args: unknown[]) => unknown>(
    func: T,
    wait?: number,
    options?: { leading?: boolean; trailing?: boolean }
  ): T & { cancel(): void; flush(): void };

  // Object utilities
  export function cloneDeep<T>(value: T): T;
  export function merge<T extends object>(object: T, ...sources: object[]): T;
  export function pick<T extends object, K extends keyof T>(object: T, ...keys: K[]): Pick<T, K>;
  export function omit<T extends object, K extends keyof T>(object: T, ...keys: K[]): Omit<T, K>;
  export function get<T>(object: object, path: string | string[], defaultValue?: T): T;
  export function set<T extends object>(object: T, path: string | string[], value: unknown): T;

  // Array utilities
  export function groupBy<T>(array: T[], iteratee: ((item: T) => string) | string): Record<string, T[]>;
  export function sortBy<T>(array: T[], iteratees: ((item: T) => unknown) | string | string[]): T[];
  export function uniq<T>(array: T[]): T[];
  export function uniqBy<T>(array: T[], iteratee: ((item: T) => unknown) | string): T[];
  export function chunk<T>(array: T[], size?: number): T[][];
  export function flatten<T>(array: (T | T[])[]): T[];
  export function flattenDeep<T>(array: unknown[]): T[];
  export function difference<T>(array: T[], ...values: T[][]): T[];
  export function intersection<T>(...arrays: T[][]): T[];
  export function compact<T>(array: (T | null | undefined | false | '' | 0)[]): T[];
  export function range(start: number, end?: number, step?: number): number[];

  // Collection utilities
  export function shuffle<T>(array: T[]): T[];
  export function sample<T>(array: T[]): T | undefined;
  export function sampleSize<T>(array: T[], n?: number): T[];

  // String utilities
  export function camelCase(string?: string): string;
  export function kebabCase(string?: string): string;
  export function snakeCase(string?: string): string;
  export function capitalize(string?: string): string;
  export function truncate(string?: string, options?: { length?: number; separator?: string | RegExp; omission?: string }): string;

  // Number utilities
  export function clamp(number: number, lower: number, upper: number): number;
  export function random(lower?: number, upper?: number, floating?: boolean): number;
}

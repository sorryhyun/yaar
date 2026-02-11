/**
 * Type definitions for @bundled/date-fns — date utility library.
 */

declare module '@bundled/date-fns' {
  // Formatting
  export function format(date: Date | number, formatStr: string): string;
  export function formatDistance(date: Date | number, baseDate: Date | number, options?: { addSuffix?: boolean; includeSeconds?: boolean }): string;
  export function formatDistanceToNow(date: Date | number, options?: { addSuffix?: boolean; includeSeconds?: boolean }): string;
  export function formatRelative(date: Date | number, baseDate: Date | number): string;

  // Parsing
  export function parse(dateString: string, formatString: string, referenceDate: Date | number): Date;
  export function parseISO(dateString: string): Date;
  export function isValid(date: Date): boolean;

  // Add/Subtract
  export function addMilliseconds(date: Date | number, amount: number): Date;
  export function addSeconds(date: Date | number, amount: number): Date;
  export function addMinutes(date: Date | number, amount: number): Date;
  export function addHours(date: Date | number, amount: number): Date;
  export function addDays(date: Date | number, amount: number): Date;
  export function addWeeks(date: Date | number, amount: number): Date;
  export function addMonths(date: Date | number, amount: number): Date;
  export function addYears(date: Date | number, amount: number): Date;

  export function subMilliseconds(date: Date | number, amount: number): Date;
  export function subSeconds(date: Date | number, amount: number): Date;
  export function subMinutes(date: Date | number, amount: number): Date;
  export function subHours(date: Date | number, amount: number): Date;
  export function subDays(date: Date | number, amount: number): Date;
  export function subWeeks(date: Date | number, amount: number): Date;
  export function subMonths(date: Date | number, amount: number): Date;
  export function subYears(date: Date | number, amount: number): Date;

  // Difference
  export function differenceInMilliseconds(dateLeft: Date | number, dateRight: Date | number): number;
  export function differenceInSeconds(dateLeft: Date | number, dateRight: Date | number): number;
  export function differenceInMinutes(dateLeft: Date | number, dateRight: Date | number): number;
  export function differenceInHours(dateLeft: Date | number, dateRight: Date | number): number;
  export function differenceInDays(dateLeft: Date | number, dateRight: Date | number): number;
  export function differenceInWeeks(dateLeft: Date | number, dateRight: Date | number): number;
  export function differenceInMonths(dateLeft: Date | number, dateRight: Date | number): number;
  export function differenceInYears(dateLeft: Date | number, dateRight: Date | number): number;

  // Comparison
  export function isAfter(date: Date | number, dateToCompare: Date | number): boolean;
  export function isBefore(date: Date | number, dateToCompare: Date | number): boolean;
  export function isEqual(dateLeft: Date | number, dateRight: Date | number): boolean;
  export function isFuture(date: Date | number): boolean;
  export function isPast(date: Date | number): boolean;
  export function isToday(date: Date | number): boolean;
  export function isTomorrow(date: Date | number): boolean;
  export function isYesterday(date: Date | number): boolean;
  export function isThisWeek(date: Date | number): boolean;
  export function isThisMonth(date: Date | number): boolean;
  export function isThisYear(date: Date | number): boolean;

  // Start/End of
  export function startOfDay(date: Date | number): Date;
  export function endOfDay(date: Date | number): Date;
  export function startOfWeek(date: Date | number, options?: { weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6 }): Date;
  export function endOfWeek(date: Date | number, options?: { weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6 }): Date;
  export function startOfMonth(date: Date | number): Date;
  export function endOfMonth(date: Date | number): Date;
  export function startOfYear(date: Date | number): Date;
  export function endOfYear(date: Date | number): Date;

  // Getters
  export function getDate(date: Date | number): number;
  export function getDay(date: Date | number): number;
  export function getMonth(date: Date | number): number;
  export function getYear(date: Date | number): number;
  export function getHours(date: Date | number): number;
  export function getMinutes(date: Date | number): number;
  export function getSeconds(date: Date | number): number;
  export function getTime(date: Date | number): number;

  // Setters
  export function setDate(date: Date | number, dayOfMonth: number): Date;
  export function setDay(date: Date | number, day: number): Date;
  export function setMonth(date: Date | number, month: number): Date;
  export function setYear(date: Date | number, year: number): Date;
  export function setHours(date: Date | number, hours: number): Date;
  export function setMinutes(date: Date | number, minutes: number): Date;
  export function setSeconds(date: Date | number, seconds: number): Date;

  // Misc
  export function min(dates: (Date | number)[]): Date;
  export function max(dates: (Date | number)[]): Date;
  export function closestTo(dateToCompare: Date | number, dates: (Date | number)[]): Date | undefined;
  export function eachDayOfInterval(interval: { start: Date | number; end: Date | number }): Date[];
  export function eachWeekOfInterval(interval: { start: Date | number; end: Date | number }): Date[];
  export function eachMonthOfInterval(interval: { start: Date | number; end: Date | number }): Date[];
}

/**
 * Type definitions for bundled libraries available via @bundled/* imports.
 *
 * These types help the AI understand the available APIs when generating
 * app code that uses bundled libraries.
 */

// ============================================================================
// UUID - Unique ID generation
// ============================================================================

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

// ============================================================================
// Lodash - Utility functions
// ============================================================================

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

// ============================================================================
// Anime.js - Animation library
// ============================================================================

declare module '@bundled/anime' {
  interface AnimeParams {
    targets: string | Element | Element[] | NodeList | object | object[];

    // Transforms
    translateX?: number | string | (number | string)[];
    translateY?: number | string | (number | string)[];
    translateZ?: number | string | (number | string)[];
    rotate?: number | string | (number | string)[];
    rotateX?: number | string | (number | string)[];
    rotateY?: number | string | (number | string)[];
    rotateZ?: number | string | (number | string)[];
    scale?: number | (number)[];
    scaleX?: number | (number)[];
    scaleY?: number | (number)[];
    skew?: number | string | (number | string)[];
    skewX?: number | string | (number | string)[];
    skewY?: number | string | (number | string)[];

    // CSS properties (any CSS property works)
    opacity?: number | (number)[];
    backgroundColor?: string | string[];
    color?: string | string[];
    width?: number | string | (number | string)[];
    height?: number | string | (number | string)[];
    top?: number | string | (number | string)[];
    left?: number | string | (number | string)[];
    borderRadius?: number | string | (number | string)[];

    // SVG attributes
    points?: string;
    strokeDashoffset?: number | string | (number | string)[];
    d?: string;

    // Animation timing
    duration?: number;
    delay?: number | ((el: Element, i: number, total: number) => number);
    endDelay?: number;
    easing?: string;

    // Animation behavior
    round?: number;
    loop?: boolean | number;
    direction?: 'normal' | 'reverse' | 'alternate';
    autoplay?: boolean;

    // Keyframes
    keyframes?: AnimeParams[];

    // Callbacks
    begin?: (anim: AnimeInstance) => void;
    update?: (anim: AnimeInstance) => void;
    complete?: (anim: AnimeInstance) => void;
    loopBegin?: (anim: AnimeInstance) => void;
    loopComplete?: (anim: AnimeInstance) => void;
    changeBegin?: (anim: AnimeInstance) => void;
    changeComplete?: (anim: AnimeInstance) => void;

    // Allow any CSS/SVG property
    [key: string]: unknown;
  }

  interface AnimeInstance {
    play(): void;
    pause(): void;
    restart(): void;
    reverse(): void;
    seek(time: number): void;
    finished: Promise<void>;
    began: boolean;
    paused: boolean;
    completed: boolean;
    progress: number;
    currentTime: number;
    duration: number;
  }

  interface AnimeTimelineInstance extends AnimeInstance {
    add(params: AnimeParams, offset?: number | string): AnimeTimelineInstance;
  }

  interface AnimeStatic {
    (params: AnimeParams): AnimeInstance;
    timeline(params?: Partial<AnimeParams>): AnimeTimelineInstance;
    stagger(value: number | string | (number | string)[], options?: {
      start?: number | string;
      from?: number | string | 'first' | 'last' | 'center';
      direction?: 'normal' | 'reverse';
      easing?: string;
      grid?: [number, number];
      axis?: 'x' | 'y';
    }): (el: Element, i: number, total: number) => number;
    set(targets: AnimeParams['targets'], values: Partial<AnimeParams>): void;
    remove(targets: AnimeParams['targets']): void;
    get(targets: Element, prop: string): string | number;
    random(min: number, max: number): number;
    running: AnimeInstance[];

    // Easing functions
    easing: {
      [key: string]: (t: number) => number;
    };
  }

  const anime: AnimeStatic;
  export default anime;
}

// ============================================================================
// Konva - 2D Canvas library
// ============================================================================

declare module '@bundled/konva' {
  interface StageConfig {
    container: HTMLElement | string;
    width: number;
    height: number;
  }

  interface LayerConfig {
    clearBeforeDraw?: boolean;
    hitGraphEnabled?: boolean;
  }

  interface ShapeConfig {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
    visible?: boolean;
    draggable?: boolean;
    name?: string;
    id?: string;
  }

  interface RectConfig extends ShapeConfig {
    cornerRadius?: number | number[];
  }

  interface CircleConfig extends ShapeConfig {
    radius: number;
  }

  interface EllipseConfig extends ShapeConfig {
    radiusX: number;
    radiusY: number;
  }

  interface LineConfig extends ShapeConfig {
    points: number[];
    closed?: boolean;
    tension?: number;
    lineCap?: 'butt' | 'round' | 'square';
    lineJoin?: 'miter' | 'round' | 'bevel';
  }

  interface TextConfig extends ShapeConfig {
    text: string;
    fontSize?: number;
    fontFamily?: string;
    fontStyle?: 'normal' | 'bold' | 'italic';
    align?: 'left' | 'center' | 'right';
    verticalAlign?: 'top' | 'middle' | 'bottom';
    padding?: number;
    lineHeight?: number;
    wrap?: 'word' | 'char' | 'none';
  }

  interface ImageConfig extends ShapeConfig {
    image: HTMLImageElement | HTMLCanvasElement;
    crop?: { x: number; y: number; width: number; height: number };
  }

  interface PathConfig extends ShapeConfig {
    data: string;
  }

  interface GroupConfig extends ShapeConfig {}

  class Node {
    x(): number;
    x(x: number): this;
    y(): number;
    y(y: number): this;
    position(): { x: number; y: number };
    position(pos: { x: number; y: number }): this;
    rotation(): number;
    rotation(rotation: number): this;
    scale(): { x: number; y: number };
    scale(scale: { x: number; y: number }): this;
    opacity(): number;
    opacity(opacity: number): this;
    visible(): boolean;
    visible(visible: boolean): this;
    draggable(): boolean;
    draggable(draggable: boolean): this;
    destroy(): void;
    remove(): void;
    getLayer(): Layer | null;
    getStage(): Stage | null;
    on(evtStr: string, handler: (e: KonvaEventObject) => void): this;
    off(evtStr: string): this;
    to(config: TweenConfig): void;
  }

  interface KonvaEventObject {
    target: Node;
    currentTarget: Node;
    evt: Event;
    cancelBubble: boolean;
  }

  interface TweenConfig {
    x?: number;
    y?: number;
    rotation?: number;
    opacity?: number;
    scaleX?: number;
    scaleY?: number;
    duration?: number;
    easing?: (t: number) => number;
    onFinish?: () => void;
    [key: string]: unknown;
  }

  class Container extends Node {
    add(...children: Node[]): this;
    getChildren(): Node[];
    find(selector: string): Node[];
    findOne(selector: string): Node | undefined;
    removeChildren(): this;
  }

  export class Stage extends Container {
    constructor(config: StageConfig);
    container(): HTMLElement;
    width(): number;
    width(width: number): this;
    height(): number;
    height(height: number): this;
    batchDraw(): this;
    toDataURL(config?: { pixelRatio?: number; mimeType?: string; quality?: number }): string;
    toImage(config?: { callback: (img: HTMLImageElement) => void; pixelRatio?: number }): void;
  }

  export class Layer extends Container {
    constructor(config?: LayerConfig);
    batchDraw(): this;
    draw(): this;
    clear(): this;
  }

  export class Group extends Container {
    constructor(config?: GroupConfig);
  }

  export class Shape extends Node {
    fill(): string;
    fill(fill: string): this;
    stroke(): string;
    stroke(stroke: string): this;
    strokeWidth(): number;
    strokeWidth(width: number): this;
  }

  export class Rect extends Shape {
    constructor(config?: RectConfig);
    width(): number;
    width(width: number): this;
    height(): number;
    height(height: number): this;
    cornerRadius(): number | number[];
    cornerRadius(radius: number | number[]): this;
  }

  export class Circle extends Shape {
    constructor(config?: CircleConfig);
    radius(): number;
    radius(radius: number): this;
  }

  export class Ellipse extends Shape {
    constructor(config?: EllipseConfig);
    radiusX(): number;
    radiusX(radius: number): this;
    radiusY(): number;
    radiusY(radius: number): this;
  }

  export class Line extends Shape {
    constructor(config?: LineConfig);
    points(): number[];
    points(points: number[]): this;
    closed(): boolean;
    closed(closed: boolean): this;
    tension(): number;
    tension(tension: number): this;
  }

  export class Text extends Shape {
    constructor(config?: TextConfig);
    text(): string;
    text(text: string): this;
    fontSize(): number;
    fontSize(size: number): this;
    fontFamily(): string;
    fontFamily(family: string): this;
    align(): string;
    align(align: string): this;
    width(): number;
    height(): number;
  }

  export class Image extends Shape {
    constructor(config?: ImageConfig);
    image(): HTMLImageElement | HTMLCanvasElement;
    image(img: HTMLImageElement | HTMLCanvasElement): this;
    static fromURL(url: string, callback: (img: Image) => void): void;
  }

  export class Path extends Shape {
    constructor(config?: PathConfig);
    data(): string;
    data(data: string): this;
  }

  export namespace Easings {
    function Linear(t: number): number;
    function EaseIn(t: number): number;
    function EaseOut(t: number): number;
    function EaseInOut(t: number): number;
    function BackEaseIn(t: number): number;
    function BackEaseOut(t: number): number;
    function BackEaseInOut(t: number): number;
    function ElasticEaseIn(t: number): number;
    function ElasticEaseOut(t: number): number;
    function ElasticEaseInOut(t: number): number;
    function BounceEaseIn(t: number): number;
    function BounceEaseOut(t: number): number;
    function BounceEaseInOut(t: number): number;
  }
}

// ============================================================================
// date-fns - Date utility library
// ============================================================================

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

// ============================================================================
// clsx - Class name utility
// ============================================================================

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

// ============================================================================
// SheetJS (xlsx) - Spreadsheet read/write
// ============================================================================

declare module '@bundled/xlsx' {
  // Cell types
  interface CellObject {
    /** Cell type: b=boolean, n=number, s=string, d=date, e=error, z=stub */
    t: 'b' | 'n' | 's' | 'd' | 'e' | 'z';
    /** Raw value */
    v?: string | number | boolean | Date;
    /** Formatted text (if available) */
    w?: string;
    /** Formula (without leading =) */
    f?: string;
  }

  interface WorkSheet {
    [cell: string]: CellObject | unknown;
    /** Range string e.g. "A1:Z100" */
    '!ref'?: string;
    /** Merge ranges */
    '!merges'?: Range[];
  }

  interface WorkBook {
    SheetNames: string[];
    Sheets: { [name: string]: WorkSheet };
  }

  interface Range {
    s: CellAddress;
    e: CellAddress;
  }

  interface CellAddress {
    /** Column (0-indexed) */
    c: number;
    /** Row (0-indexed) */
    r: number;
  }

  interface WritingOptions {
    bookType?: 'xlsx' | 'csv' | 'ods';
    type?: 'array' | 'binary' | 'base64' | 'buffer';
    compression?: boolean;
  }

  interface ParsingOptions {
    type?: 'array' | 'binary' | 'base64' | 'buffer';
    cellFormula?: boolean;
    cellStyles?: boolean;
  }

  /** Read a workbook from binary data */
  export function read(data: Uint8Array | ArrayBuffer | string, opts?: ParsingOptions): WorkBook;

  /** Write a workbook to binary data */
  export function write(wb: WorkBook, opts?: WritingOptions): Uint8Array | string;

  export namespace utils {
    /** Create a new empty workbook */
    function book_new(): WorkBook;
    /** Append a worksheet to a workbook */
    function book_append_sheet(wb: WorkBook, ws: WorkSheet, name?: string): void;
    /** Encode a range object to a string like "A1:Z100" */
    function encode_range(range: Range): string;
    /** Decode a range string to a range object */
    function decode_range(range: string): Range;
    /** Encode a cell address to a string like "A1" */
    function encode_cell(cell: CellAddress): string;
    /** Decode a cell string to a cell address */
    function decode_cell(cell: string): CellAddress;
    /** Convert an array of arrays to a worksheet */
    function aoa_to_sheet(data: unknown[][]): WorkSheet;
    /** Convert a worksheet to an array of arrays */
    function sheet_to_json<T = unknown>(ws: WorkSheet, opts?: { header?: 1 | string[]; raw?: boolean }): T[];
    /** Convert a worksheet to CSV string */
    function sheet_to_csv(ws: WorkSheet): string;
  }
}

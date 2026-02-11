/**
 * Type definitions for @bundled/pixi.js — 2D WebGL/Canvas renderer.
 */

declare module '@bundled/pixi.js' {
  // Core types

  interface PointLike {
    x: number;
    y: number;
  }

  interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
    contains(x: number, y: number): boolean;
  }

  interface DestroyOptions {
    children?: boolean;
    texture?: boolean;
    baseTexture?: boolean;
  }

  // Application

  interface ApplicationOptions {
    width?: number;
    height?: number;
    view?: HTMLCanvasElement;
    canvas?: HTMLCanvasElement;
    background?: string | number;
    backgroundColor?: string | number;
    backgroundAlpha?: number;
    resolution?: number;
    antialias?: boolean;
    autoDensity?: boolean;
    autoStart?: boolean;
    resizeTo?: HTMLElement | Window;
    hello?: boolean;
    preference?: 'webgl' | 'webgpu';
  }

  export class Application {
    stage: Container;
    renderer: Renderer;
    screen: Rectangle;
    canvas: HTMLCanvasElement;
    ticker: Ticker;

    constructor();
    init(options?: ApplicationOptions): Promise<void>;
    destroy(removeView?: boolean, stageOptions?: DestroyOptions): void;
    resize(): void;
    render(): void;
    stop(): void;
    start(): void;
  }

  // Renderer

  interface Renderer {
    width: number;
    height: number;
    resolution: number;
    canvas: HTMLCanvasElement;
    screen: Rectangle;
    resize(width: number, height: number): void;
    render(container: Container): void;
    destroy(removeView?: boolean): void;
    background: { color: number | string };
  }

  // Display Objects

  interface EventEmitter {
    on(event: string, fn: (...args: unknown[]) => void, context?: unknown): this;
    once(event: string, fn: (...args: unknown[]) => void, context?: unknown): this;
    off(event: string, fn?: (...args: unknown[]) => void, context?: unknown): this;
    emit(event: string, ...args: unknown[]): boolean;
    removeAllListeners(event?: string): this;
  }

  export class Container implements EventEmitter {
    children: Container[];
    parent: Container | null;
    visible: boolean;
    alpha: number;
    x: number;
    y: number;
    position: { x: number; y: number; set(x: number, y?: number): void };
    scale: { x: number; y: number; set(x: number, y?: number): void };
    pivot: { x: number; y: number; set(x: number, y?: number): void };
    anchor: { x: number; y: number; set(x: number, y?: number): void };
    skew: { x: number; y: number; set(x: number, y?: number): void };
    rotation: number;
    angle: number;
    width: number;
    height: number;
    interactive: boolean;
    eventMode: 'none' | 'passive' | 'auto' | 'static' | 'dynamic';
    cursor: string;
    label: string;
    sortableChildren: boolean;
    zIndex: number;
    tint: number | string;
    blendMode: string;
    filters: unknown[] | null;
    mask: Container | Graphics | null;

    constructor();
    addChild<T extends Container>(...children: T[]): T;
    removeChild<T extends Container>(...children: T[]): T;
    removeChildAt(index: number): Container;
    removeChildren(beginIndex?: number, endIndex?: number): Container[];
    getChildAt(index: number): Container;
    getChildByLabel(label: string, deep?: boolean): Container | null;
    setChildIndex(child: Container, index: number): void;
    sortChildren(): void;
    destroy(options?: DestroyOptions): void;
    getBounds(): Rectangle;
    getLocalBounds(): Rectangle;
    toGlobal(position: PointLike): PointLike;
    toLocal(position: PointLike, from?: Container): PointLike;

    // EventEmitter
    on(event: string, fn: (...args: unknown[]) => void, context?: unknown): this;
    once(event: string, fn: (...args: unknown[]) => void, context?: unknown): this;
    off(event: string, fn?: (...args: unknown[]) => void, context?: unknown): this;
    emit(event: string, ...args: unknown[]): boolean;
    removeAllListeners(event?: string): this;
  }

  // Sprite

  export class Sprite extends Container {
    texture: Texture;
    anchor: { x: number; y: number; set(x: number, y?: number): void };
    tint: number | string;
    blendMode: string;
    roundPixels: boolean;

    constructor(texture?: Texture);
    static from(source: string | Texture | HTMLCanvasElement | HTMLImageElement): Sprite;
    destroy(options?: DestroyOptions): void;
  }

  // AnimatedSprite

  export class AnimatedSprite extends Sprite {
    animationSpeed: number;
    loop: boolean;
    currentFrame: number;
    playing: boolean;
    totalFrames: number;
    onComplete: (() => void) | null;
    onFrameChange: ((currentFrame: number) => void) | null;

    constructor(textures: Texture[], autoUpdate?: boolean);
    play(): void;
    stop(): void;
    gotoAndPlay(frameNumber: number): void;
    gotoAndStop(frameNumber: number): void;
  }

  // Graphics

  interface FillStyle {
    color?: number | string;
    alpha?: number;
    texture?: Texture;
  }

  interface StrokeStyle {
    color?: number | string;
    alpha?: number;
    width?: number;
    alignment?: number;
    cap?: 'butt' | 'round' | 'square';
    join?: 'miter' | 'round' | 'bevel';
    miterLimit?: number;
  }

  export class Graphics extends Container {
    constructor();

    // Chainable drawing API
    rect(x: number, y: number, width: number, height: number): this;
    roundRect(x: number, y: number, width: number, height: number, radius?: number): this;
    circle(x: number, y: number, radius: number): this;
    ellipse(x: number, y: number, halfWidth: number, halfHeight: number): this;
    poly(points: number[] | PointLike[]): this;
    regularPoly(x: number, y: number, radius: number, sides: number, rotation?: number): this;
    star(x: number, y: number, points: number, radius: number, innerRadius?: number, rotation?: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    quadraticCurveTo(cpX: number, cpY: number, toX: number, toY: number): this;
    bezierCurveTo(cpX: number, cpY: number, cpX2: number, cpY2: number, toX: number, toY: number): this;
    arc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean): this;
    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): this;
    closePath(): this;

    fill(style?: FillStyle | number | string): this;
    stroke(style?: StrokeStyle | { width: number; color: number | string }): this;
    clear(): this;
    destroy(options?: DestroyOptions): void;
  }

  // Text

  interface TextStyleOptions {
    align?: 'left' | 'center' | 'right' | 'justify';
    breakWords?: boolean;
    dropShadow?: boolean | { alpha?: number; angle?: number; blur?: number; color?: string | number; distance?: number };
    fill?: string | number | string[] | number[] | CanvasGradient | CanvasPattern;
    fontFamily?: string | string[];
    fontSize?: number | string;
    fontStyle?: 'normal' | 'italic' | 'oblique';
    fontWeight?: 'normal' | 'bold' | 'bolder' | 'lighter' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';
    letterSpacing?: number;
    lineHeight?: number;
    padding?: number;
    stroke?: string | number | { color?: string | number; width?: number };
    wordWrap?: boolean;
    wordWrapWidth?: number;
  }

  export class TextStyle {
    constructor(style?: TextStyleOptions);
    clone(): TextStyle;
    reset(): void;
  }

  export class Text extends Container {
    text: string;
    style: TextStyle | TextStyleOptions;
    resolution: number;
    anchor: { x: number; y: number; set(x: number, y?: number): void };

    constructor(options?: { text?: string; style?: TextStyleOptions | TextStyle; resolution?: number });
    destroy(options?: DestroyOptions): void;
  }

  export class BitmapText extends Container {
    text: string;
    style: { fontFamily: string; fontSize?: number; align?: string; tint?: number; letterSpacing?: number; maxWidth?: number };
    anchor: { x: number; y: number; set(x: number, y?: number): void };

    constructor(options?: { text?: string; style?: { fontFamily: string; fontSize?: number; align?: string; tint?: number; letterSpacing?: number; maxWidth?: number } });
  }

  // Textures

  export class Texture {
    width: number;
    height: number;
    orig: Rectangle;
    frame: Rectangle;
    label: string;

    static from(source: string | HTMLCanvasElement | HTMLImageElement): Texture;
    static readonly EMPTY: Texture;
    static readonly WHITE: Texture;
    destroy(destroyBase?: boolean): void;
    clone(): Texture;
  }

  // Assets

  export namespace Assets {
    function load<T = unknown>(url: string | string[]): Promise<T>;
    function add(options: { alias: string | string[]; src: string; data?: unknown }): void;
    function addBundle(bundleId: string, assets: Record<string, string>): void;
    function loadBundle(bundleId: string): Promise<Record<string, unknown>>;
    function unload(url: string | string[]): Promise<void>;
    function get<T = unknown>(url: string): T | undefined;
    function init(options?: { basePath?: string; manifest?: unknown }): Promise<void>;
  }

  // Ticker

  export class Ticker {
    autoStart: boolean;
    deltaTime: number;
    deltaMS: number;
    elapsedMS: number;
    FPS: number;
    maxFPS: number;
    minFPS: number;
    speed: number;
    started: boolean;

    add(fn: (dt: Ticker) => void, context?: unknown, priority?: number): this;
    addOnce(fn: (dt: Ticker) => void, context?: unknown, priority?: number): this;
    remove(fn: (dt: Ticker) => void, context?: unknown): this;
    start(): void;
    stop(): void;
    update(currentTime?: number): void;
    destroy(): void;

    static shared: Ticker;
    static system: Ticker;
  }

  // Filters
  export class BlurFilter {
    blur: number;
    quality: number;
    constructor(options?: { strength?: number; quality?: number });
  }

  export class AlphaFilter {
    alpha: number;
    constructor(options?: { alpha?: number });
  }

  export class ColorMatrixFilter {
    brightness(b: number, multiply?: boolean): void;
    contrast(amount: number, multiply?: boolean): void;
    saturate(amount?: number, multiply?: boolean): void;
    desaturate(): void;
    greyscale(scale: number, multiply?: boolean): void;
    hue(rotation: number, multiply?: boolean): void;
    sepia(multiply?: boolean): void;
    night(intensity: number, multiply?: boolean): void;
    vintage(multiply?: boolean): void;
    reset(): void;
  }

  export class DisplacementFilter {
    scale: { x: number; y: number };
    constructor(options: { sprite: Sprite; scale?: number | { x: number; y: number } });
  }

  // TilingSprite
  export class TilingSprite extends Sprite {
    tilePosition: { x: number; y: number; set(x: number, y?: number): void };
    tileScale: { x: number; y: number; set(x: number, y?: number): void };
    clampMargin: number;

    constructor(options?: { texture?: Texture; width?: number; height?: number });
  }

  // NineSliceSprite
  export class NineSliceSprite extends Container {
    constructor(options: { texture: Texture; leftWidth?: number; topHeight?: number; rightWidth?: number; bottomHeight?: number });
  }

  // RenderTexture
  export class RenderTexture extends Texture {
    static create(options?: { width?: number; height?: number; resolution?: number }): RenderTexture;
    resize(width: number, height: number): void;
    destroy(destroyBase?: boolean): void;
  }

  // Color
  export class Color {
    constructor(value?: string | number | number[] | { r: number; g: number; b: number; a?: number });
    toNumber(): number;
    toRgbaString(): string;
    toHex(): string;
    toArray(): number[];
  }

  // Interaction events (FederatedEvent)
  interface FederatedPointerEvent {
    clientX: number;
    clientY: number;
    globalX: number;
    globalY: number;
    global: PointLike;
    screen: PointLike;
    button: number;
    buttons: number;
    pointerId: number;
    pointerType: string;
    target: Container;
    currentTarget: Container;
    type: string;
    isTrusted: boolean;
    timeStamp: number;
    preventDefault(): void;
    stopPropagation(): void;
    getLocalPosition(displayObject: Container): PointLike;
  }

  // Constants
  export const BLEND_MODES: {
    NORMAL: string;
    ADD: string;
    MULTIPLY: string;
    SCREEN: string;
  };

  // Math utilities
  export class Point implements PointLike {
    x: number;
    y: number;
    constructor(x?: number, y?: number);
    set(x?: number, y?: number): void;
    clone(): Point;
    copyFrom(p: PointLike): this;
    equals(p: PointLike): boolean;
  }

  export class ObservablePoint implements PointLike {
    x: number;
    y: number;
    set(x?: number, y?: number): void;
    clone(): Point;
  }

  export class Matrix {
    a: number; b: number; c: number; d: number; tx: number; ty: number;
    constructor(a?: number, b?: number, c?: number, d?: number, tx?: number, ty?: number);
    set(a: number, b: number, c: number, d: number, tx: number, ty: number): this;
    translate(x: number, y: number): this;
    scale(x: number, y: number): this;
    rotate(angle: number): this;
    identity(): this;
    invert(): this;
    clone(): Matrix;
    static readonly IDENTITY: Matrix;
  }

  // Particle container
  export class ParticleContainer extends Container {
    constructor(options?: { maxSize?: number; properties?: { position?: boolean; rotation?: boolean; tint?: boolean; uvs?: boolean } });
  }
}

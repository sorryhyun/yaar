/**
 * Type definitions for @bundled/konva — 2D canvas library.
 */

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

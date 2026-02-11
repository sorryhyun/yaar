/**
 * Type definitions for @bundled/d3 — data visualization library.
 */

declare module '@bundled/d3' {
  // Selection

  interface Selection<GElement extends Element = Element, Datum = unknown> {
    select(selector: string): Selection<Element, Datum>;
    selectAll(selector: string): Selection<Element, Datum>;
    append(type: string): Selection<Element, Datum>;
    insert(type: string, before?: string): Selection<Element, Datum>;
    remove(): this;
    clone(deep?: boolean): Selection<GElement, Datum>;
    text(): string;
    text(value: string | number | ((d: Datum, i: number) => string | number)): this;
    html(): string;
    html(value: string | ((d: Datum, i: number) => string)): this;
    attr(name: string): string;
    attr(name: string, value: string | number | boolean | null | ((d: Datum, i: number, nodes: GElement[]) => string | number | boolean | null)): this;
    style(name: string): string;
    style(name: string, value: string | number | null | ((d: Datum, i: number) => string | number | null), priority?: 'important' | null): this;
    classed(names: string): boolean;
    classed(names: string, value: boolean | ((d: Datum, i: number) => boolean)): this;
    property(name: string): unknown;
    property(name: string, value: unknown): this;
    datum(): Datum;
    datum<NewDatum>(value: NewDatum): Selection<GElement, NewDatum>;
    data(): Datum[];
    data<NewDatum>(data: NewDatum[] | ((d: Datum) => NewDatum[]), key?: (d: NewDatum, i: number) => string): Selection<GElement, NewDatum>;
    enter(): Selection<GElement, Datum>;
    exit(): Selection<GElement, Datum>;
    join(enter: string | ((enter: Selection) => Selection), update?: (update: Selection) => Selection, exit?: (exit: Selection) => Selection): Selection<GElement, Datum>;
    merge(other: Selection<GElement, Datum>): Selection<GElement, Datum>;
    on(typenames: string): ((event: Event, d: Datum) => void) | undefined;
    on(typenames: string, listener: null): this;
    on(typenames: string, listener: (event: Event, d: Datum) => void): this;
    call(fn: (selection: Selection<GElement, Datum>, ...args: unknown[]) => void, ...args: unknown[]): this;
    each(fn: (d: Datum, i: number, nodes: GElement[]) => void): this;
    filter(selector: string | ((d: Datum, i: number) => boolean)): Selection<GElement, Datum>;
    sort(comparator: (a: Datum, b: Datum) => number): this;
    order(): this;
    raise(): this;
    lower(): this;
    node(): GElement | null;
    nodes(): GElement[];
    size(): number;
    empty(): boolean;
    transition(name?: string): Transition<GElement, Datum>;
  }

  export function select(selector: string | Element): Selection;
  export function selectAll(selector: string | Element[] | NodeList): Selection;
  export function create(name: string): Selection;

  // Scales

  interface ScaleContinuous<Range = number> {
    (value: number): Range;
    domain(): number[];
    domain(domain: number[]): this;
    range(): Range[];
    range(range: Range[]): this;
    clamp(): boolean;
    clamp(clamp: boolean): this;
    nice(count?: number): this;
    ticks(count?: number): number[];
    tickFormat(count?: number, specifier?: string): (d: number) => string;
    invert(value: Range): number;
    copy(): this;
  }

  interface ScaleBand {
    (value: string): number | undefined;
    domain(): string[];
    domain(domain: string[]): this;
    range(): [number, number];
    range(range: [number, number]): this;
    rangeRound(range: [number, number]): this;
    bandwidth(): number;
    step(): number;
    padding(): number;
    padding(padding: number): this;
    paddingInner(): number;
    paddingInner(padding: number): this;
    paddingOuter(): number;
    paddingOuter(padding: number): this;
    align(): number;
    align(align: number): this;
    copy(): this;
  }

  interface ScaleOrdinal<Range = string> {
    (value: string): Range;
    domain(): string[];
    domain(domain: string[]): this;
    range(): Range[];
    range(range: Range[]): this;
    unknown(): Range;
    unknown(value: Range): this;
    copy(): this;
  }

  interface ScalePoint {
    (value: string): number | undefined;
    domain(): string[];
    domain(domain: string[]): this;
    range(): [number, number];
    range(range: [number, number]): this;
    bandwidth(): number;
    step(): number;
    padding(): number;
    padding(padding: number): this;
    copy(): this;
  }

  interface ScaleTime<Range = number> {
    (value: Date): Range;
    domain(): Date[];
    domain(domain: Date[]): this;
    range(): Range[];
    range(range: Range[]): this;
    nice(interval?: unknown): this;
    ticks(count?: number): Date[];
    tickFormat(count?: number, specifier?: string): (d: Date) => string;
    invert(value: Range): Date;
    copy(): this;
  }

  export function scaleLinear(): ScaleContinuous;
  export function scaleLog(): ScaleContinuous;
  export function scalePow(): ScaleContinuous & { exponent(): number; exponent(e: number): ScaleContinuous };
  export function scaleSqrt(): ScaleContinuous;
  export function scaleBand(): ScaleBand;
  export function scaleOrdinal<R = string>(range?: R[]): ScaleOrdinal<R>;
  export function scalePoint(): ScalePoint;
  export function scaleTime(): ScaleTime;
  export function scaleUtc(): ScaleTime;
  export function scaleSequential(interpolator?: (t: number) => string): ScaleContinuous<string>;

  // Color schemes
  export const schemeCategory10: string[];
  export const schemeSet1: string[];
  export const schemeSet2: string[];
  export const schemeSet3: string[];
  export const schemePaired: string[];
  export const schemeTableau10: string[];

  export function interpolateViridis(t: number): string;
  export function interpolateInferno(t: number): string;
  export function interpolatePlasma(t: number): string;
  export function interpolateRainbow(t: number): string;
  export function interpolateBlues(t: number): string;
  export function interpolateReds(t: number): string;
  export function interpolateGreens(t: number): string;

  // Axes

  interface Axis<Domain> {
    (selection: Selection): void;
    scale(): unknown;
    scale(scale: unknown): this;
    ticks(count?: number, specifier?: string): this;
    tickValues(): Domain[] | null;
    tickValues(values: Domain[] | null): this;
    tickFormat(): ((d: Domain) => string) | null;
    tickFormat(format: ((d: Domain) => string) | null): this;
    tickSize(): number;
    tickSize(size: number): this;
    tickSizeInner(): number;
    tickSizeInner(size: number): this;
    tickSizeOuter(): number;
    tickSizeOuter(size: number): this;
    tickPadding(): number;
    tickPadding(padding: number): this;
  }

  export function axisTop(scale: unknown): Axis<unknown>;
  export function axisRight(scale: unknown): Axis<unknown>;
  export function axisBottom(scale: unknown): Axis<unknown>;
  export function axisLeft(scale: unknown): Axis<unknown>;

  // Shapes

  interface LineGenerator<Datum = [number, number]> {
    (data: Datum[]): string | null;
    x(): (d: Datum, i: number) => number;
    x(x: number | ((d: Datum, i: number) => number)): this;
    y(): (d: Datum, i: number) => number;
    y(y: number | ((d: Datum, i: number) => number)): this;
    defined(): (d: Datum, i: number) => boolean;
    defined(defined: boolean | ((d: Datum, i: number) => boolean)): this;
    curve(): unknown;
    curve(curve: unknown): this;
  }

  interface AreaGenerator<Datum = [number, number]> {
    (data: Datum[]): string | null;
    x(): (d: Datum, i: number) => number;
    x(x: number | ((d: Datum, i: number) => number)): this;
    x0(): (d: Datum, i: number) => number;
    x0(x0: number | ((d: Datum, i: number) => number)): this;
    x1(): (d: Datum, i: number) => number;
    x1(x1: number | ((d: Datum, i: number) => number)): this;
    y(): (d: Datum, i: number) => number;
    y(y: number | ((d: Datum, i: number) => number)): this;
    y0(): (d: Datum, i: number) => number;
    y0(y0: number | ((d: Datum, i: number) => number)): this;
    y1(): (d: Datum, i: number) => number;
    y1(y1: number | ((d: Datum, i: number) => number)): this;
    defined(): (d: Datum, i: number) => boolean;
    defined(defined: boolean | ((d: Datum, i: number) => boolean)): this;
    curve(): unknown;
    curve(curve: unknown): this;
  }

  interface ArcGenerator<Datum = { startAngle: number; endAngle: number; innerRadius: number; outerRadius: number }> {
    (d: Datum): string | null;
    innerRadius(): (d: Datum) => number;
    innerRadius(radius: number | ((d: Datum) => number)): this;
    outerRadius(): (d: Datum) => number;
    outerRadius(radius: number | ((d: Datum) => number)): this;
    cornerRadius(): (d: Datum) => number;
    cornerRadius(radius: number | ((d: Datum) => number)): this;
    padAngle(): (d: Datum) => number;
    padAngle(angle: number | ((d: Datum) => number)): this;
    centroid(d: Datum): [number, number];
  }

  interface PieGenerator<Datum = number> {
    (data: Datum[]): PieArcDatum<Datum>[];
    value(): (d: Datum, i: number) => number;
    value(value: number | ((d: Datum, i: number) => number)): this;
    sort(): ((a: Datum, b: Datum) => number) | null;
    sort(comparator: ((a: Datum, b: Datum) => number) | null): this;
    sortValues(): ((a: number, b: number) => number) | null;
    sortValues(comparator: ((a: number, b: number) => number) | null): this;
    startAngle(): number | ((d: Datum[]) => number);
    startAngle(angle: number | ((d: Datum[]) => number)): this;
    endAngle(): number | ((d: Datum[]) => number);
    endAngle(angle: number | ((d: Datum[]) => number)): this;
    padAngle(): number | ((d: Datum[]) => number);
    padAngle(angle: number | ((d: Datum[]) => number)): this;
  }

  interface PieArcDatum<Datum> {
    data: Datum;
    value: number;
    index: number;
    startAngle: number;
    endAngle: number;
    padAngle: number;
  }

  export function line<Datum = [number, number]>(): LineGenerator<Datum>;
  export function area<Datum = [number, number]>(): AreaGenerator<Datum>;
  export function arc<Datum = unknown>(): ArcGenerator<Datum>;
  export function pie<Datum = unknown>(): PieGenerator<Datum>;
  export function symbol(): { (d?: unknown): string; type(type: unknown): unknown; size(size: number): unknown };
  export function stack(): { (data: unknown[]): unknown[][]; keys(keys: string[]): unknown; order(order: unknown): unknown; offset(offset: unknown): unknown };

  // Curves
  export const curveLinear: unknown;
  export const curveStep: unknown;
  export const curveStepBefore: unknown;
  export const curveStepAfter: unknown;
  export const curveBasis: unknown;
  export const curveCardinal: unknown;
  export const curveCatmullRom: unknown;
  export const curveMonotoneX: unknown;
  export const curveMonotoneY: unknown;
  export const curveNatural: unknown;
  export const curveBumpX: unknown;
  export const curveBumpY: unknown;

  // Transitions

  interface Transition<GElement extends Element = Element, Datum = unknown> {
    attr(name: string, value: string | number | null | ((d: Datum, i: number) => string | number | null)): this;
    style(name: string, value: string | number | null | ((d: Datum, i: number) => string | number | null)): this;
    text(value: string | number | ((d: Datum, i: number) => string | number)): this;
    duration(ms: number): this;
    delay(ms: number | ((d: Datum, i: number) => number)): this;
    ease(fn: (t: number) => number): this;
    on(type: 'start' | 'end' | 'interrupt', listener: (d: Datum) => void): this;
    remove(): this;
    transition(): this;
    selection(): Selection<GElement, Datum>;
    tween(name: string, tweenFn: () => (t: number) => void): this;
    attrTween(name: string, tweenFn: (d: Datum, i: number) => (t: number) => string): this;
    styleTween(name: string, tweenFn: (d: Datum, i: number) => (t: number) => string): this;
  }

  export function transition(name?: string): Transition;

  // Easing
  export function easeLinear(t: number): number;
  export function easeQuad(t: number): number;
  export function easeQuadIn(t: number): number;
  export function easeQuadOut(t: number): number;
  export function easeCubic(t: number): number;
  export function easeCubicIn(t: number): number;
  export function easeCubicOut(t: number): number;
  export function easeElastic(t: number): number;
  export function easeBounce(t: number): number;
  export function easeBack(t: number): number;

  // Array utilities
  export function min<T>(array: T[], accessor?: (d: T) => number | undefined): number | undefined;
  export function max<T>(array: T[], accessor?: (d: T) => number | undefined): number | undefined;
  export function extent<T>(array: T[], accessor?: (d: T) => number | undefined): [number, number] | [undefined, undefined];
  export function sum<T>(array: T[], accessor?: (d: T) => number): number;
  export function mean<T>(array: T[], accessor?: (d: T) => number): number | undefined;
  export function median<T>(array: T[], accessor?: (d: T) => number): number | undefined;
  export function range(start: number, stop?: number, step?: number): number[];
  export function group<T, K>(iterable: Iterable<T>, key: (d: T) => K): Map<K, T[]>;
  export function rollup<T, K, V>(iterable: Iterable<T>, reduce: (values: T[]) => V, key: (d: T) => K): Map<K, V>;
  export function sort<T>(iterable: Iterable<T>, comparator: (a: T, b: T) => number): T[];
  export function ascending(a: unknown, b: unknown): number;
  export function descending(a: unknown, b: unknown): number;
  export function bin(): { (data: number[]): { x0: number; x1: number; length: number }[]; domain(domain: [number, number]): unknown; thresholds(count: number): unknown };

  // Format
  export function format(specifier: string): (n: number) => string;
  export function formatPrefix(specifier: string, value: number): (n: number) => string;

  // Time format
  export function timeFormat(specifier: string): (date: Date) => string;
  export function timeParse(specifier: string): (dateString: string) => Date | null;
  export function utcFormat(specifier: string): (date: Date) => string;
  export function utcParse(specifier: string): (dateString: string) => Date | null;

  // Force simulation
  interface SimulationNode {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
    index?: number;
  }

  interface SimulationLink<N extends SimulationNode = SimulationNode> {
    source: N | string | number;
    target: N | string | number;
    index?: number;
  }

  interface Simulation<N extends SimulationNode = SimulationNode> {
    nodes(): N[];
    nodes(nodes: N[]): this;
    force(name: string): unknown;
    force(name: string, force: unknown | null): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaMin(min: number): this;
    alphaDecay(): number;
    alphaDecay(decay: number): this;
    alphaTarget(): number;
    alphaTarget(target: number): this;
    tick(iterations?: number): this;
    restart(): this;
    stop(): this;
    on(typenames: string): ((event: unknown) => void) | undefined;
    on(typenames: string, listener: null | ((event: unknown) => void)): this;
    find(x: number, y: number, radius?: number): N | undefined;
  }

  export function forceSimulation<N extends SimulationNode = SimulationNode>(nodes?: N[]): Simulation<N>;
  export function forceLink<N extends SimulationNode = SimulationNode>(links?: SimulationLink<N>[]): {
    (alpha: number): void;
    links(): SimulationLink<N>[];
    links(links: SimulationLink<N>[]): unknown;
    id(id: (node: N) => string | number): unknown;
    distance(distance: number | ((link: SimulationLink<N>) => number)): unknown;
    strength(strength: number | ((link: SimulationLink<N>) => number)): unknown;
  };
  export function forceManyBody(): { (alpha: number): void; strength(strength: number | ((d: unknown) => number)): unknown; distanceMin(distance: number): unknown; distanceMax(distance: number): unknown };
  export function forceCenter(x?: number, y?: number): { (alpha: number): void; x(x: number): unknown; y(y: number): unknown; strength(strength: number): unknown };
  export function forceCollide(radius?: number | ((d: unknown) => number)): { (alpha: number): void; radius(radius: number | ((d: unknown) => number)): unknown; strength(strength: number): unknown };
  export function forceX(x?: number | ((d: unknown) => number)): unknown;
  export function forceY(y?: number | ((d: unknown) => number)): unknown;
  export function forceRadial(radius: number | ((d: unknown) => number), x?: number, y?: number): unknown;

  // Hierarchy / Tree
  interface HierarchyNode<Datum> {
    data: Datum;
    depth: number;
    height: number;
    parent: HierarchyNode<Datum> | null;
    children?: HierarchyNode<Datum>[];
    value?: number;
    x?: number;
    y?: number;
    sum(value: (d: Datum) => number): this;
    sort(compare: (a: HierarchyNode<Datum>, b: HierarchyNode<Datum>) => number): this;
    each(callback: (node: HierarchyNode<Datum>) => void): this;
    descendants(): HierarchyNode<Datum>[];
    ancestors(): HierarchyNode<Datum>[];
    leaves(): HierarchyNode<Datum>[];
    links(): { source: HierarchyNode<Datum>; target: HierarchyNode<Datum> }[];
    copy(): HierarchyNode<Datum>;
  }

  export function hierarchy<Datum>(data: Datum, children?: (d: Datum) => Datum[] | undefined): HierarchyNode<Datum>;
  export function tree<Datum>(): { (root: HierarchyNode<Datum>): HierarchyNode<Datum>; size(size: [number, number]): unknown; nodeSize(size: [number, number]): unknown };
  export function treemap<Datum>(): { (root: HierarchyNode<Datum>): HierarchyNode<Datum>; size(size: [number, number]): unknown; padding(padding: number): unknown; tile(tile: unknown): unknown };
  export function pack<Datum>(): { (root: HierarchyNode<Datum>): HierarchyNode<Datum>; size(size: [number, number]): unknown; padding(padding: number): unknown };

  // Geo
  interface GeoPath {
    (object: unknown): string | null;
    projection(): unknown;
    projection(projection: unknown): this;
    centroid(object: unknown): [number, number];
    bounds(object: unknown): [[number, number], [number, number]];
    area(object: unknown): number;
  }

  interface GeoProjection {
    (point: [number, number]): [number, number] | null;
    invert(point: [number, number]): [number, number] | null;
    scale(): number;
    scale(scale: number): this;
    translate(): [number, number];
    translate(translate: [number, number]): this;
    center(): [number, number];
    center(center: [number, number]): this;
    rotate(): [number, number, number];
    rotate(angles: [number, number, number]): this;
    fitSize(size: [number, number], object: unknown): this;
    fitExtent(extent: [[number, number], [number, number]], object: unknown): this;
  }

  export function geoPath(projection?: unknown): GeoPath;
  export function geoMercator(): GeoProjection;
  export function geoAlbersUsa(): GeoProjection;
  export function geoEquirectangular(): GeoProjection;
  export function geoOrthographic(): GeoProjection;
  export function geoNaturalEarth1(): GeoProjection;
  export function geoGraticule(): { (): unknown; step(step: [number, number]): unknown };

  // Zoom
  interface ZoomBehavior<GElement extends Element = Element, Datum = unknown> {
    (selection: Selection<GElement, Datum>): void;
    transform(selection: Selection<GElement, Datum>, transform: ZoomTransform): void;
    scaleBy(selection: Selection<GElement, Datum>, k: number): void;
    scaleTo(selection: Selection<GElement, Datum>, k: number): void;
    translateBy(selection: Selection<GElement, Datum>, x: number, y: number): void;
    translateTo(selection: Selection<GElement, Datum>, x: number, y: number): void;
    scaleExtent(): [number, number];
    scaleExtent(extent: [number, number]): this;
    translateExtent(): [[number, number], [number, number]];
    translateExtent(extent: [[number, number], [number, number]]): this;
    on(typenames: string): ((event: unknown) => void) | undefined;
    on(typenames: string, listener: null | ((event: { transform: ZoomTransform; sourceEvent: Event }) => void)): this;
  }

  interface ZoomTransform {
    x: number;
    y: number;
    k: number;
    apply(point: [number, number]): [number, number];
    invert(point: [number, number]): [number, number];
    rescaleX(x: unknown): unknown;
    rescaleY(y: unknown): unknown;
    toString(): string;
  }

  export function zoom<GElement extends Element = Element, Datum = unknown>(): ZoomBehavior<GElement, Datum>;
  export const zoomIdentity: ZoomTransform;

  // Drag
  interface DragBehavior<GElement extends Element = Element, Datum = unknown> {
    (selection: Selection<GElement, Datum>): void;
    on(typenames: string): ((event: unknown) => void) | undefined;
    on(typenames: string, listener: null | ((event: { x: number; y: number; dx: number; dy: number; subject: Datum; sourceEvent: Event }) => void)): this;
    subject(subject: (event: unknown, d: Datum) => unknown): this;
    container(container: unknown): this;
  }

  export function drag<GElement extends Element = Element, Datum = unknown>(): DragBehavior<GElement, Datum>;

  // Brush
  interface BrushBehavior<Datum = unknown> {
    (selection: Selection): void;
    on(typenames: string): ((event: unknown) => void) | undefined;
    on(typenames: string, listener: null | ((event: { selection: [[number, number], [number, number]] | null }) => void)): this;
    extent(extent: [[number, number], [number, number]]): this;
    move(selection: Selection, extent: [[number, number], [number, number]] | null): void;
  }

  export function brush(): BrushBehavior;
  export function brushX(): BrushBehavior;
  export function brushY(): BrushBehavior;

  // Color
  export function color(specifier: string): { r: number; g: number; b: number; opacity: number; toString(): string } | null;
  export function rgb(r: number, g: number, b: number, opacity?: number): { r: number; g: number; b: number; opacity: number; toString(): string };
  export function hsl(h: number, s: number, l: number, opacity?: number): { h: number; s: number; l: number; opacity: number; toString(): string };
  export function interpolate(a: unknown, b: unknown): (t: number) => unknown;
  export function interpolateRgb(a: string, b: string): (t: number) => string;
  export function interpolateNumber(a: number, b: number): (t: number) => number;
}

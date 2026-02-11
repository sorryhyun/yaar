/**
 * Type definitions for @bundled/p5 — creative coding library.
 */

declare module '@bundled/p5' {
  type Color = string | number | number[];

  interface p5Image {
    width: number;
    height: number;
    pixels: number[];
    loadPixels(): void;
    updatePixels(): void;
    get(x?: number, y?: number, w?: number, h?: number): p5Image | number[];
    set(x: number, y: number, a: number | number[] | p5Image): void;
    resize(width: number, height: number): void;
    copy(src: p5Image | undefined, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
    mask(maskImage: p5Image): void;
    filter(filterType: string, filterParam?: number): void;
    save(filename: string, extension?: string): void;
  }

  interface p5Font {
    textBounds(str: string, x: number, y: number, fontSize?: number): { x: number; y: number; w: number; h: number };
  }

  interface p5Vector {
    x: number;
    y: number;
    z: number;
    set(x?: number, y?: number, z?: number): p5Vector;
    copy(): p5Vector;
    add(v: p5Vector | number, y?: number, z?: number): p5Vector;
    sub(v: p5Vector | number, y?: number, z?: number): p5Vector;
    mult(n: number): p5Vector;
    div(n: number): p5Vector;
    mag(): number;
    magSq(): number;
    dot(v: p5Vector | number, y?: number, z?: number): number;
    cross(v: p5Vector): p5Vector;
    dist(v: p5Vector): number;
    normalize(): p5Vector;
    limit(max: number): p5Vector;
    setMag(len: number): p5Vector;
    heading(): number;
    rotate(angle: number): p5Vector;
    lerp(v: p5Vector | number, amt: number, y?: number, z?: number): p5Vector;
    array(): number[];
    equals(v: p5Vector | number[]): boolean;
  }

  interface p5Graphics {
    // Same drawing API as p5 instance — simplified here
    background(v1: Color, v2?: number, v3?: number, a?: number): void;
    fill(v1: Color, v2?: number, v3?: number, a?: number): void;
    noFill(): void;
    stroke(v1: Color, v2?: number, v3?: number, a?: number): void;
    noStroke(): void;
    rect(x: number, y: number, w: number, h?: number, tl?: number, tr?: number, br?: number, bl?: number): void;
    ellipse(x: number, y: number, w: number, h?: number): void;
    line(x1: number, y1: number, x2: number, y2: number): void;
    text(str: string, x: number, y: number, x2?: number, y2?: number): void;
    image(img: p5Image | p5Graphics, x: number, y: number, width?: number, height?: number): void;
    clear(): void;
    remove(): void;
    width: number;
    height: number;
  }

  class p5 {
    constructor(sketch: (p: p5) => void, node?: HTMLElement);

    // Environment
    width: number;
    height: number;
    frameCount: number;
    deltaTime: number;
    focused: boolean;
    displayWidth: number;
    displayHeight: number;
    windowWidth: number;
    windowHeight: number;
    pixelDensity(val?: number): number;
    frameRate(fps?: number): number;
    fullscreen(val?: boolean): boolean;
    noCursor(): void;
    cursor(type?: string): void;

    // Canvas
    createCanvas(w: number, h: number, renderer?: string): HTMLCanvasElement;
    resizeCanvas(w: number, h: number, noRedraw?: boolean): void;
    noCanvas(): void;
    createGraphics(w: number, h: number, renderer?: string): p5Graphics;

    // Color
    background(v1: Color, v2?: number, v3?: number, a?: number): void;
    clear(): void;
    fill(v1: Color, v2?: number, v3?: number, a?: number): void;
    noFill(): void;
    stroke(v1: Color, v2?: number, v3?: number, a?: number): void;
    noStroke(): void;
    strokeWeight(weight: number): void;
    strokeCap(cap: string): void;
    strokeJoin(join: string): void;
    colorMode(mode: string, max1?: number, max2?: number, max3?: number, maxA?: number): void;
    color(v1: Color, v2?: number, v3?: number, a?: number): object;
    lerpColor(c1: object, c2: object, amt: number): object;
    red(c: object): number;
    green(c: object): number;
    blue(c: object): number;
    alpha(c: object): number;
    hue(c: object): number;
    saturation(c: object): number;
    brightness(c: object): number;

    // Shapes — 2D primitives
    arc(x: number, y: number, w: number, h: number, start: number, stop: number, mode?: string, detail?: number): void;
    ellipse(x: number, y: number, w: number, h?: number): void;
    circle(x: number, y: number, d: number): void;
    line(x1: number, y1: number, x2: number, y2: number): void;
    point(x: number, y: number, z?: number): void;
    quad(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): void;
    rect(x: number, y: number, w: number, h?: number, tl?: number, tr?: number, br?: number, bl?: number): void;
    square(x: number, y: number, s: number, tl?: number, tr?: number, br?: number, bl?: number): void;
    triangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;

    // Shapes — vertices
    beginShape(kind?: number): void;
    vertex(x: number, y: number, z?: number): void;
    curveVertex(x: number, y: number): void;
    bezierVertex(x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): void;
    endShape(mode?: string): void;

    // Shapes — curves
    bezier(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): void;
    curve(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): void;

    // Transform
    translate(x: number, y: number, z?: number): void;
    rotate(angle: number): void;
    rotateX(angle: number): void;
    rotateY(angle: number): void;
    rotateZ(angle: number): void;
    scale(s: number, y?: number, z?: number): void;
    shearX(angle: number): void;
    shearY(angle: number): void;
    push(): void;
    pop(): void;
    resetMatrix(): void;
    applyMatrix(a: number, b: number, c: number, d: number, e: number, f: number): void;

    // Text
    text(str: string | number, x: number, y: number, x2?: number, y2?: number): void;
    textFont(font: string | p5Font, size?: number): void;
    textSize(s?: number): number;
    textAlign(horizAlign: string, vertAlign?: string): void;
    textWidth(str: string): number;
    textAscent(): number;
    textDescent(): number;
    textLeading(leading?: number): number;
    textStyle(style?: string): string;
    textWrap(wrapStyle: string): void;

    // Image
    loadImage(path: string, successCallback?: (img: p5Image) => void, failureCallback?: (event: Event) => void): p5Image;
    image(img: p5Image | p5Graphics, x: number, y: number, width?: number, height?: number): void;
    imageMode(mode: string): void;
    tint(v1: Color, v2?: number, v3?: number, a?: number): void;
    noTint(): void;
    createImage(width: number, height: number): p5Image;

    // Pixels
    pixels: number[];
    loadPixels(): void;
    updatePixels(): void;
    get(x?: number, y?: number, w?: number, h?: number): p5Image | number[];
    set(x: number, y: number, c: number | number[] | p5Image): void;

    // Math
    abs(n: number): number;
    ceil(n: number): number;
    constrain(n: number, low: number, high: number): number;
    dist(x1: number, y1: number, x2: number, y2: number): number;
    exp(n: number): number;
    floor(n: number): number;
    lerp(start: number, stop: number, amt: number): number;
    log(n: number): number;
    mag(a: number, b: number): number;
    map(value: number, start1: number, stop1: number, start2: number, stop2: number, withinBounds?: boolean): number;
    max(...ns: number[]): number;
    min(...ns: number[]): number;
    norm(value: number, start: number, stop: number): number;
    pow(n: number, e: number): number;
    round(n: number, decimals?: number): number;
    sq(n: number): number;
    sqrt(n: number): number;

    // Trigonometry
    sin(angle: number): number;
    cos(angle: number): number;
    tan(angle: number): number;
    asin(value: number): number;
    acos(value: number): number;
    atan(value: number): number;
    atan2(y: number, x: number): number;
    degrees(radians: number): number;
    radians(degrees: number): number;
    angleMode(mode: string): void;

    // Random
    random(min?: number | unknown[], max?: number): number | unknown;
    randomSeed(seed: number): void;
    randomGaussian(mean?: number, sd?: number): number;
    noise(x: number, y?: number, z?: number): number;
    noiseDetail(lod: number, falloff?: number): void;
    noiseSeed(seed: number): void;

    // Vector
    createVector(x?: number, y?: number, z?: number): p5Vector;

    // Input — Mouse
    mouseX: number;
    mouseY: number;
    pmouseX: number;
    pmouseY: number;
    mouseButton: string;
    mouseIsPressed: boolean;
    movedX: number;
    movedY: number;

    // Input — Keyboard
    key: string;
    keyCode: number;
    keyIsPressed: boolean;
    keyIsDown(code: number): boolean;

    // Input — Touch
    touches: { x: number; y: number; id: number }[];

    // Events (assigned as properties in instance mode)
    setup?: () => void;
    draw?: () => void;
    preload?: () => void;
    mousePressed?: (event?: MouseEvent) => void;
    mouseReleased?: (event?: MouseEvent) => void;
    mouseClicked?: (event?: MouseEvent) => void;
    mouseMoved?: (event?: MouseEvent) => void;
    mouseDragged?: (event?: MouseEvent) => void;
    mouseWheel?: (event?: WheelEvent) => void;
    doubleClicked?: (event?: MouseEvent) => void;
    keyPressed?: (event?: KeyboardEvent) => void;
    keyReleased?: (event?: KeyboardEvent) => void;
    keyTyped?: (event?: KeyboardEvent) => void;
    touchStarted?: (event?: TouchEvent) => void;
    touchMoved?: (event?: TouchEvent) => void;
    touchEnded?: (event?: TouchEvent) => void;
    windowResized?: () => void;

    // Time
    millis(): number;
    second(): number;
    minute(): number;
    hour(): number;
    day(): number;
    month(): number;
    year(): number;

    // DOM
    select(selectors: string, container?: string | HTMLElement): unknown | null;
    selectAll(selectors: string, container?: string | HTMLElement): unknown[];
    createElement(tag: string, content?: string): unknown;
    createDiv(html?: string): unknown;
    createP(html?: string): unknown;
    createSpan(html?: string): unknown;
    createButton(label: string, value?: string): unknown;
    createSlider(min: number, max: number, value?: number, step?: number): unknown;
    createInput(value?: string, type?: string): unknown;
    createSelect(multiple?: boolean): unknown;

    // Animation control
    loop(): void;
    noLoop(): void;
    isLooping(): boolean;
    redraw(n?: number): void;

    // Structure
    remove(): void;

    // Sound (basic)
    loadSound?(path: string, callback?: () => void): unknown;

    // Constants
    PI: number;
    TWO_PI: number;
    HALF_PI: number;
    QUARTER_PI: number;
    TAU: number;
    DEGREES: string;
    RADIANS: string;
    CENTER: string;
    LEFT: string;
    RIGHT: string;
    TOP: string;
    BOTTOM: string;
    BASELINE: string;
    CORNERS: string;
    CORNER: string;
    RADIUS: string;
    CLOSE: string;
    OPEN: string;
    CHORD: string;
    PIE: string;
    POINTS: number;
    LINES: number;
    TRIANGLES: number;
    TRIANGLE_FAN: number;
    TRIANGLE_STRIP: number;
    QUADS: number;
    QUAD_STRIP: number;
    WEBGL: string;
    P2D: string;
    ARROW: string;
    CROSS: string;
    HAND: string;
    MOVE: string;
    TEXT: string;
    BOLD: string;
    ITALIC: string;
    NORMAL: string;
    RGB: string;
    HSB: string;
    HSL: string;
  }

  export default p5;
}

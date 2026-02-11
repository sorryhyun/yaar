/**
 * Type definitions for @bundled/three — 3D graphics/WebGL library.
 */

declare module '@bundled/three' {
  // Core

  class EventDispatcher {
    addEventListener(type: string, listener: (event: { type: string; target: unknown }) => void): void;
    removeEventListener(type: string, listener: (event: { type: string; target: unknown }) => void): void;
    dispatchEvent(event: { type: string; [key: string]: unknown }): void;
  }

  export class Object3D extends EventDispatcher {
    position: Vector3;
    rotation: Euler;
    scale: Vector3;
    quaternion: Quaternion;
    visible: boolean;
    name: string;
    parent: Object3D | null;
    children: Object3D[];
    userData: Record<string, unknown>;

    add(...object: Object3D[]): this;
    remove(...object: Object3D[]): this;
    lookAt(x: number | Vector3, y?: number, z?: number): void;
    traverse(callback: (object: Object3D) => void): void;
    getWorldPosition(target: Vector3): Vector3;
    clone(recursive?: boolean): this;
  }

  // Math

  export class Vector2 {
    x: number;
    y: number;
    constructor(x?: number, y?: number);
    set(x: number, y: number): this;
    clone(): Vector2;
    copy(v: Vector2): this;
    add(v: Vector2): this;
    sub(v: Vector2): this;
    multiplyScalar(s: number): this;
    length(): number;
    normalize(): this;
  }

  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
    clone(): Vector3;
    copy(v: Vector3): this;
    add(v: Vector3): this;
    sub(v: Vector3): this;
    multiply(v: Vector3): this;
    multiplyScalar(s: number): this;
    divideScalar(s: number): this;
    cross(v: Vector3): this;
    dot(v: Vector3): number;
    length(): number;
    normalize(): this;
    distanceTo(v: Vector3): number;
    lerp(v: Vector3, alpha: number): this;
    applyMatrix4(m: Matrix4): this;
    applyQuaternion(q: Quaternion): this;
  }

  export class Vector4 {
    x: number;
    y: number;
    z: number;
    w: number;
    constructor(x?: number, y?: number, z?: number, w?: number);
    set(x: number, y: number, z: number, w: number): this;
  }

  export class Euler {
    x: number;
    y: number;
    z: number;
    order: string;
    constructor(x?: number, y?: number, z?: number, order?: string);
    set(x: number, y: number, z: number, order?: string): this;
  }

  export class Quaternion {
    x: number;
    y: number;
    z: number;
    w: number;
    constructor(x?: number, y?: number, z?: number, w?: number);
    set(x: number, y: number, z: number, w: number): this;
    setFromEuler(euler: Euler): this;
    setFromAxisAngle(axis: Vector3, angle: number): this;
    slerp(q: Quaternion, t: number): this;
  }

  export class Matrix4 {
    elements: number[];
    constructor();
    set(...values: number[]): this;
    identity(): this;
    multiply(m: Matrix4): this;
    makeRotationFromEuler(euler: Euler): this;
    makeTranslation(x: number, y: number, z: number): this;
    makeScale(x: number, y: number, z: number): this;
    lookAt(eye: Vector3, target: Vector3, up: Vector3): this;
  }

  export class Box3 {
    min: Vector3;
    max: Vector3;
    constructor(min?: Vector3, max?: Vector3);
    setFromObject(object: Object3D): this;
    getCenter(target: Vector3): Vector3;
    getSize(target: Vector3): Vector3;
  }

  export class Color {
    r: number;
    g: number;
    b: number;
    constructor(color?: string | number | Color);
    set(color: string | number | Color): this;
    setHSL(h: number, s: number, l: number): this;
    setRGB(r: number, g: number, b: number): this;
    clone(): Color;
    getHexString(): string;
  }

  export class Clock {
    autoStart: boolean;
    running: boolean;
    elapsedTime: number;
    constructor(autoStart?: boolean);
    start(): void;
    stop(): void;
    getElapsedTime(): number;
    getDelta(): number;
  }

  // Cameras

  export class Camera extends Object3D {
    matrixWorldInverse: Matrix4;
    projectionMatrix: Matrix4;
  }

  export class PerspectiveCamera extends Camera {
    fov: number;
    aspect: number;
    near: number;
    far: number;
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    updateProjectionMatrix(): void;
  }

  export class OrthographicCamera extends Camera {
    left: number;
    right: number;
    top: number;
    bottom: number;
    near: number;
    far: number;
    zoom: number;
    constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
    updateProjectionMatrix(): void;
  }

  // Renderer

  interface WebGLRendererParameters {
    canvas?: HTMLCanvasElement;
    antialias?: boolean;
    alpha?: boolean;
    precision?: string;
    preserveDrawingBuffer?: boolean;
  }

  export class WebGLRenderer {
    domElement: HTMLCanvasElement;
    shadowMap: { enabled: boolean; type: number };
    constructor(parameters?: WebGLRendererParameters);
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setPixelRatio(value: number): void;
    setClearColor(color: Color | string | number, alpha?: number): void;
    render(scene: Scene, camera: Camera): void;
    dispose(): void;
    setAnimationLoop(callback: ((time: number) => void) | null): void;
  }

  // Scene

  export class Scene extends Object3D {
    background: Color | Texture | null;
    fog: Fog | FogExp2 | null;
    constructor();
  }

  export class Fog {
    color: Color;
    near: number;
    far: number;
    constructor(color: string | number, near?: number, far?: number);
  }

  export class FogExp2 {
    color: Color;
    density: number;
    constructor(color: string | number, density?: number);
  }

  // Geometry

  export class BufferGeometry {
    attributes: Record<string, BufferAttribute>;
    index: BufferAttribute | null;
    dispose(): void;
    setAttribute(name: string, attribute: BufferAttribute): this;
    setIndex(index: BufferAttribute | number[]): this;
    computeVertexNormals(): void;
  }

  export class BufferAttribute {
    array: Float32Array;
    itemSize: number;
    constructor(array: ArrayLike<number>, itemSize: number, normalized?: boolean);
  }

  export class BoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number, widthSegments?: number, heightSegments?: number, depthSegments?: number);
  }

  export class SphereGeometry extends BufferGeometry {
    constructor(radius?: number, widthSegments?: number, heightSegments?: number);
  }

  export class PlaneGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, widthSegments?: number, heightSegments?: number);
  }

  export class CylinderGeometry extends BufferGeometry {
    constructor(radiusTop?: number, radiusBottom?: number, height?: number, radialSegments?: number, heightSegments?: number, openEnded?: boolean);
  }

  export class ConeGeometry extends BufferGeometry {
    constructor(radius?: number, height?: number, radialSegments?: number, heightSegments?: number, openEnded?: boolean);
  }

  export class TorusGeometry extends BufferGeometry {
    constructor(radius?: number, tube?: number, radialSegments?: number, tubularSegments?: number);
  }

  export class RingGeometry extends BufferGeometry {
    constructor(innerRadius?: number, outerRadius?: number, thetaSegments?: number);
  }

  export class CircleGeometry extends BufferGeometry {
    constructor(radius?: number, segments?: number);
  }

  // Materials

  interface MaterialParameters {
    color?: string | number | Color;
    opacity?: number;
    transparent?: boolean;
    side?: number;
    visible?: boolean;
    wireframe?: boolean;
    depthTest?: boolean;
    depthWrite?: boolean;
  }

  export class Material {
    opacity: number;
    transparent: boolean;
    visible: boolean;
    side: number;
    dispose(): void;
    clone(): this;
  }

  export class MeshBasicMaterial extends Material {
    color: Color;
    map: Texture | null;
    constructor(parameters?: MaterialParameters & { map?: Texture });
  }

  export class MeshStandardMaterial extends Material {
    color: Color;
    roughness: number;
    metalness: number;
    map: Texture | null;
    normalMap: Texture | null;
    emissive: Color;
    emissiveIntensity: number;
    constructor(parameters?: MaterialParameters & {
      roughness?: number;
      metalness?: number;
      map?: Texture;
      normalMap?: Texture;
      emissive?: string | number | Color;
      emissiveIntensity?: number;
    });
  }

  export class MeshPhongMaterial extends Material {
    color: Color;
    specular: Color;
    shininess: number;
    map: Texture | null;
    constructor(parameters?: MaterialParameters & {
      specular?: string | number | Color;
      shininess?: number;
      map?: Texture;
    });
  }

  export class MeshLambertMaterial extends Material {
    color: Color;
    map: Texture | null;
    constructor(parameters?: MaterialParameters & { map?: Texture });
  }

  export class LineBasicMaterial extends Material {
    color: Color;
    linewidth: number;
    constructor(parameters?: MaterialParameters & { linewidth?: number });
  }

  export class PointsMaterial extends Material {
    color: Color;
    size: number;
    map: Texture | null;
    constructor(parameters?: MaterialParameters & { size?: number; map?: Texture; sizeAttenuation?: boolean });
  }

  export class SpriteMaterial extends Material {
    color: Color;
    map: Texture | null;
    constructor(parameters?: MaterialParameters & { map?: Texture });
  }

  // Objects

  export class Mesh extends Object3D {
    geometry: BufferGeometry;
    material: Material | Material[];
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
  }

  export class Group extends Object3D {
    constructor();
  }

  export class Line extends Object3D {
    geometry: BufferGeometry;
    material: Material;
    constructor(geometry?: BufferGeometry, material?: Material);
  }

  export class Points extends Object3D {
    geometry: BufferGeometry;
    material: Material;
    constructor(geometry?: BufferGeometry, material?: Material);
  }

  export class Sprite extends Object3D {
    material: SpriteMaterial;
    constructor(material?: SpriteMaterial);
  }

  // Lights

  export class Light extends Object3D {
    color: Color;
    intensity: number;
    constructor(color?: string | number, intensity?: number);
  }

  export class AmbientLight extends Light {
    constructor(color?: string | number, intensity?: number);
  }

  export class DirectionalLight extends Light {
    target: Object3D;
    shadow: { mapSize: Vector2; camera: Camera };
    castShadow: boolean;
    constructor(color?: string | number, intensity?: number);
  }

  export class PointLight extends Light {
    distance: number;
    decay: number;
    castShadow: boolean;
    constructor(color?: string | number, intensity?: number, distance?: number, decay?: number);
  }

  export class SpotLight extends Light {
    target: Object3D;
    angle: number;
    penumbra: number;
    distance: number;
    decay: number;
    castShadow: boolean;
    constructor(color?: string | number, intensity?: number, distance?: number, angle?: number, penumbra?: number, decay?: number);
  }

  export class HemisphereLight extends Light {
    groundColor: Color;
    constructor(skyColor?: string | number, groundColor?: string | number, intensity?: number);
  }

  // Texture

  export class Texture {
    image: HTMLImageElement | HTMLCanvasElement;
    needsUpdate: boolean;
    wrapS: number;
    wrapT: number;
    repeat: Vector2;
    offset: Vector2;
    dispose(): void;
    clone(): Texture;
  }

  export class TextureLoader {
    load(url: string, onLoad?: (texture: Texture) => void, onProgress?: (event: ProgressEvent) => void, onError?: (event: ErrorEvent) => void): Texture;
    loadAsync(url: string): Promise<Texture>;
  }

  // Raycasting

  export class Raycaster {
    ray: { origin: Vector3; direction: Vector3 };
    near: number;
    far: number;
    constructor(origin?: Vector3, direction?: Vector3, near?: number, far?: number);
    setFromCamera(coords: Vector2, camera: Camera): void;
    intersectObject(object: Object3D, recursive?: boolean): Intersection[];
    intersectObjects(objects: Object3D[], recursive?: boolean): Intersection[];
  }

  interface Intersection {
    distance: number;
    point: Vector3;
    face: { a: number; b: number; c: number; normal: Vector3 } | null;
    object: Object3D;
  }

  // Animation

  export class AnimationMixer extends EventDispatcher {
    constructor(root: Object3D);
    clipAction(clip: AnimationClip): AnimationAction;
    update(delta: number): void;
    stopAllAction(): void;
  }

  export class AnimationClip {
    name: string;
    duration: number;
    tracks: KeyframeTrack[];
    constructor(name?: string, duration?: number, tracks?: KeyframeTrack[]);
  }

  export class AnimationAction {
    play(): this;
    stop(): this;
    reset(): this;
    setLoop(mode: number, repetitions: number): this;
    setDuration(duration: number): this;
    fadeIn(duration: number): this;
    fadeOut(duration: number): this;
    crossFadeTo(action: AnimationAction, duration: number, warp: boolean): this;
    clampWhenFinished: boolean;
    timeScale: number;
    weight: number;
    paused: boolean;
  }

  export class KeyframeTrack {
    constructor(name: string, times: number[], values: number[]);
  }

  // Helpers

  export class AxesHelper extends Object3D {
    constructor(size?: number);
  }

  export class GridHelper extends Object3D {
    constructor(size?: number, divisions?: number, color1?: string | number, color2?: string | number);
  }

  export class ArrowHelper extends Object3D {
    constructor(dir: Vector3, origin?: Vector3, length?: number, color?: number);
  }

  // Constants
  export const DoubleSide: number;
  export const FrontSide: number;
  export const BackSide: number;
  export const RepeatWrapping: number;
  export const ClampToEdgeWrapping: number;
  export const MirroredRepeatWrapping: number;
  export const NearestFilter: number;
  export const LinearFilter: number;
  export const LoopOnce: number;
  export const LoopRepeat: number;
  export const LoopPingPong: number;
  export const PCFSoftShadowMap: number;

  // Math utilities
  export namespace MathUtils {
    function clamp(value: number, min: number, max: number): number;
    function lerp(x: number, y: number, t: number): number;
    function degToRad(degrees: number): number;
    function radToDeg(radians: number): number;
    function randFloat(low: number, high: number): number;
    function randInt(low: number, high: number): number;
    function mapLinear(x: number, a1: number, a2: number, b1: number, b2: number): number;
  }
}

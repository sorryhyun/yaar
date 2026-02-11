/**
 * Type definitions for @bundled/matter-js — 2D physics engine.
 */

declare module '@bundled/matter-js' {
  // Common types

  interface Vector {
    x: number;
    y: number;
  }

  interface Bounds {
    min: Vector;
    max: Vector;
  }

  interface Vertices {
    x: number;
    y: number;
  }

  // Engine

  interface IEngineDefinition {
    gravity?: { x?: number; y?: number; scale?: number };
    enableSleeping?: boolean;
    timing?: { timeScale?: number };
    constraintIterations?: number;
    positionIterations?: number;
    velocityIterations?: number;
  }

  interface Engine {
    world: World;
    gravity: { x: number; y: number; scale: number };
    timing: { timestamp: number; timeScale: number };
    enableSleeping: boolean;
  }

  export namespace Engine {
    function create(options?: IEngineDefinition): Engine;
    function update(engine: Engine, delta?: number, correction?: number): void;
    function clear(engine: Engine): void;
  }

  // World / Composite

  interface World {
    bodies: Body[];
    constraints: Constraint[];
    composites: Composite[];
    gravity: { x: number; y: number; scale: number };
    bounds: Bounds;
  }

  interface Composite {
    bodies: Body[];
    constraints: Constraint[];
    composites: Composite[];
    id: number;
    label: string;
  }

  export namespace Composite {
    function add(composite: World | Composite, object: Body | Constraint | Composite | (Body | Constraint | Composite)[]): World | Composite;
    function remove(composite: World | Composite, object: Body | Constraint | Composite, deep?: boolean): World | Composite;
    function allBodies(composite: World | Composite): Body[];
    function allConstraints(composite: World | Composite): Constraint[];
    function clear(composite: World | Composite, keepStatic?: boolean, deep?: boolean): void;
  }

  /** @deprecated Use Composite instead */
  export namespace World {
    function add(world: World, body: Body | Constraint | Composite | (Body | Constraint | Composite)[]): void;
    function remove(world: World, body: Body | Constraint | Composite, deep?: boolean): void;
    function clear(world: World, keepStatic?: boolean): void;
  }

  // Body

  interface IBodyDefinition {
    position?: Vector;
    velocity?: Vector;
    angle?: number;
    angularVelocity?: number;
    force?: Vector;
    mass?: number;
    density?: number;
    inertia?: number;
    isStatic?: boolean;
    isSensor?: boolean;
    isSleeping?: boolean;
    restitution?: number;
    friction?: number;
    frictionAir?: number;
    frictionStatic?: number;
    slop?: number;
    collisionFilter?: { group?: number; category?: number; mask?: number };
    render?: { visible?: boolean; fillStyle?: string; strokeStyle?: string; lineWidth?: number; opacity?: number; sprite?: { texture?: string; xScale?: number; yScale?: number } };
    label?: string;
    plugin?: Record<string, unknown>;
    chamfer?: { radius?: number | number[] };
  }

  interface Body {
    id: number;
    label: string;
    position: Vector;
    velocity: Vector;
    angle: number;
    angularVelocity: number;
    force: Vector;
    torque: number;
    mass: number;
    inverseMass: number;
    density: number;
    inertia: number;
    isStatic: boolean;
    isSensor: boolean;
    isSleeping: boolean;
    restitution: number;
    friction: number;
    frictionAir: number;
    frictionStatic: number;
    bounds: Bounds;
    vertices: Vertices[];
    speed: number;
    angularSpeed: number;
    collisionFilter: { group: number; category: number; mask: number };
    render: { visible: boolean; fillStyle: string; strokeStyle: string; lineWidth: number; opacity: number };
  }

  export namespace Body {
    function create(options: IBodyDefinition): Body;
    function setPosition(body: Body, position: Vector): void;
    function setVelocity(body: Body, velocity: Vector): void;
    function setAngle(body: Body, angle: number): void;
    function setAngularVelocity(body: Body, velocity: number): void;
    function setStatic(body: Body, isStatic: boolean): void;
    function setMass(body: Body, mass: number): void;
    function setDensity(body: Body, density: number): void;
    function applyForce(body: Body, position: Vector, force: Vector): void;
    function translate(body: Body, translation: Vector): void;
    function rotate(body: Body, rotation: number, point?: Vector): void;
    function scale(body: Body, scaleX: number, scaleY: number, point?: Vector): void;
  }

  export namespace Bodies {
    function rectangle(x: number, y: number, width: number, height: number, options?: IBodyDefinition): Body;
    function circle(x: number, y: number, radius: number, options?: IBodyDefinition, maxSides?: number): Body;
    function polygon(x: number, y: number, sides: number, radius: number, options?: IBodyDefinition): Body;
    function trapezoid(x: number, y: number, width: number, height: number, slope: number, options?: IBodyDefinition): Body;
    function fromVertices(x: number, y: number, vertexSets: Vector[][], options?: IBodyDefinition): Body;
  }

  // Constraint

  interface IConstraintDefinition {
    bodyA?: Body;
    bodyB?: Body;
    pointA?: Vector;
    pointB?: Vector;
    length?: number;
    stiffness?: number;
    damping?: number;
    render?: { visible?: boolean; strokeStyle?: string; lineWidth?: number; type?: 'line' | 'spring' | 'pin' };
    label?: string;
  }

  interface Constraint {
    id: number;
    label: string;
    bodyA: Body | null;
    bodyB: Body | null;
    pointA: Vector;
    pointB: Vector;
    length: number;
    stiffness: number;
    damping: number;
    render: { visible: boolean; strokeStyle: string; lineWidth: number };
  }

  export namespace Constraint {
    function create(options: IConstraintDefinition): Constraint;
  }

  // Render

  interface IRenderDefinition {
    element?: HTMLElement;
    engine: Engine;
    canvas?: HTMLCanvasElement;
    options?: {
      width?: number;
      height?: number;
      pixelRatio?: number;
      background?: string;
      wireframeBackground?: string;
      wireframes?: boolean;
      showVelocity?: boolean;
      showAngleIndicator?: boolean;
      showCollisions?: boolean;
      showSleeping?: boolean;
      showIds?: boolean;
      showBounds?: boolean;
      showAxes?: boolean;
      hasBounds?: boolean;
    };
  }

  interface Render {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    engine: Engine;
    options: IRenderDefinition['options'];
  }

  export namespace Render {
    function create(options: IRenderDefinition): Render;
    function run(render: Render): void;
    function stop(render: Render): void;
    function lookAt(render: Render, objects: Body | Body[] | { min: Vector; max: Vector }, padding?: Vector, center?: boolean): void;
  }

  // Runner

  interface Runner {
    enabled: boolean;
    fps: number;
  }

  export namespace Runner {
    function create(options?: { isFixed?: boolean; delta?: number; fps?: number }): Runner;
    function run(runner: Runner, engine: Engine): Runner;
    function run(engine: Engine): Runner;
    function stop(runner: Runner): void;
  }

  // Mouse & MouseConstraint

  interface Mouse {
    position: Vector;
    absolute: Vector;
    mousedownPosition: Vector;
    mouseupPosition: Vector;
    button: number;
  }

  export namespace Mouse {
    function create(element: HTMLElement): Mouse;
    function setOffset(mouse: Mouse, offset: Vector): void;
    function setScale(mouse: Mouse, scale: Vector): void;
  }

  interface MouseConstraint {
    mouse: Mouse;
    body: Body | null;
    constraint: Constraint;
  }

  export namespace MouseConstraint {
    function create(engine: Engine, options?: {
      mouse?: Mouse;
      constraint?: Partial<IConstraintDefinition>;
      collisionFilter?: { group?: number; category?: number; mask?: number };
    }): MouseConstraint;
  }

  // Events

  export namespace Events {
    function on(object: Engine | Body | MouseConstraint | Render | Runner, eventNames: string, callback: (event: {
      name?: string;
      source?: unknown;
      pairs?: { bodyA: Body; bodyB: Body }[];
      body?: Body;
      mouse?: Mouse;
      timestamp?: number;
    }) => void): void;
    function off(object: Engine | Body | MouseConstraint | Render | Runner, eventNames: string, callback: Function): void;
    function trigger(object: unknown, eventNames: string, event?: unknown): void;
  }

  // Vector utilities

  export namespace Vector {
    function create(x?: number, y?: number): Vector;
    function add(vectorA: Vector, vectorB: Vector): Vector;
    function sub(vectorA: Vector, vectorB: Vector): Vector;
    function mult(vector: Vector, scalar: number): Vector;
    function div(vector: Vector, scalar: number): Vector;
    function magnitude(vector: Vector): number;
    function magnitudeSquared(vector: Vector): number;
    function normalise(vector: Vector): Vector;
    function dot(vectorA: Vector, vectorB: Vector): number;
    function cross(vectorA: Vector, vectorB: Vector): number;
    function rotate(vector: Vector, angle: number): Vector;
    function angle(vectorA: Vector, vectorB: Vector): number;
    function perp(vector: Vector, negate?: boolean): Vector;
    function neg(vector: Vector): Vector;
    function clone(vector: Vector): Vector;
  }

  // Utility
  export namespace Common {
    function extend(obj: object, ...sources: object[]): object;
    function clone<T>(obj: T, deep?: boolean): T;
    function choose<T>(choices: T[]): T;
    function random(min?: number, max?: number): number;
    function clamp(value: number, min: number, max: number): number;
  }

  // Query
  export namespace Query {
    function point(bodies: Body[], point: Vector): Body[];
    function region(bodies: Body[], bounds: Bounds, outside?: boolean): Body[];
    function ray(bodies: Body[], startPoint: Vector, endPoint: Vector, rayWidth?: number): { body: Body; bodyA: Body; bodyB: Body; parentA: Body; parentB: Body }[];
  }
}

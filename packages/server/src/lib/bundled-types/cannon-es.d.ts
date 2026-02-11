/**
 * Type definitions for @bundled/cannon-es — 3D physics engine.
 */

declare module '@bundled/cannon-es' {
  // Math

  export class Vec3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
    copy(v: Vec3): this;
    clone(): Vec3;
    vadd(v: Vec3, target?: Vec3): Vec3;
    vsub(v: Vec3, target?: Vec3): Vec3;
    scale(scalar: number, target?: Vec3): Vec3;
    cross(v: Vec3, target?: Vec3): Vec3;
    dot(v: Vec3): number;
    length(): number;
    normalize(): this;
    distanceTo(v: Vec3): number;
    lerp(v: Vec3, t: number, target?: Vec3): Vec3;

    static ZERO: Vec3;
    static UNIT_X: Vec3;
    static UNIT_Y: Vec3;
    static UNIT_Z: Vec3;
  }

  export class Quaternion {
    x: number;
    y: number;
    z: number;
    w: number;
    constructor(x?: number, y?: number, z?: number, w?: number);
    set(x: number, y: number, z: number, w: number): this;
    copy(q: Quaternion): this;
    clone(): Quaternion;
    setFromAxisAngle(axis: Vec3, angle: number): this;
    setFromEuler(x: number, y: number, z: number, order?: string): this;
    toEuler(target: Vec3, order?: string): void;
    normalize(): this;
    mult(q: Quaternion, target?: Quaternion): Quaternion;
    vmult(v: Vec3, target?: Vec3): Vec3;
  }

  // Shapes

  export class Shape {
    type: number;
    boundingSphereRadius: number;
    static types: {
      SPHERE: number;
      PLANE: number;
      BOX: number;
      CYLINDER: number;
      CONVEXPOLYHEDRON: number;
      HEIGHTFIELD: number;
      TRIMESH: number;
    };
  }

  export class Box extends Shape {
    halfExtents: Vec3;
    constructor(halfExtents: Vec3);
  }

  export class Sphere extends Shape {
    radius: number;
    constructor(radius: number);
  }

  export class Plane extends Shape {
    constructor();
  }

  export class Cylinder extends Shape {
    radiusTop: number;
    radiusBottom: number;
    height: number;
    constructor(radiusTop: number, radiusBottom: number, height: number, numSegments?: number);
  }

  export class ConvexPolyhedron extends Shape {
    vertices: Vec3[];
    faces: number[][];
    constructor(props?: { vertices?: Vec3[]; faces?: number[][] });
  }

  export class Heightfield extends Shape {
    data: number[][];
    elementSize: number;
    constructor(data: number[][], options?: { elementSize?: number });
  }

  export class Trimesh extends Shape {
    vertices: number[];
    indices: number[];
    constructor(vertices: number[], indices: number[]);
  }

  // Material & Contact

  export class Material {
    name: string;
    friction: number;
    restitution: number;
    constructor(options?: string | { friction?: number; restitution?: number });
  }

  export class ContactMaterial {
    friction: number;
    restitution: number;
    contactEquationStiffness: number;
    contactEquationRelaxation: number;
    constructor(m1: Material, m2: Material, options?: {
      friction?: number;
      restitution?: number;
      contactEquationStiffness?: number;
      contactEquationRelaxation?: number;
    });
  }

  // Body

  export const BODY_TYPES: {
    DYNAMIC: number;
    STATIC: number;
    KINEMATIC: number;
  };

  interface BodyOptions {
    mass?: number;
    position?: Vec3;
    velocity?: Vec3;
    angularVelocity?: Vec3;
    quaternion?: Quaternion;
    shape?: Shape;
    material?: Material;
    type?: number;
    linearDamping?: number;
    angularDamping?: number;
    fixedRotation?: boolean;
    collisionFilterGroup?: number;
    collisionFilterMask?: number;
    isTrigger?: boolean;
  }

  export class Body {
    id: number;
    position: Vec3;
    velocity: Vec3;
    angularVelocity: Vec3;
    quaternion: Quaternion;
    mass: number;
    type: number;
    material: Material | null;
    linearDamping: number;
    angularDamping: number;
    fixedRotation: boolean;
    collisionFilterGroup: number;
    collisionFilterMask: number;
    shapes: Shape[];
    isTrigger: boolean;
    sleepState: number;

    constructor(options?: BodyOptions);
    addShape(shape: Shape, offset?: Vec3, orientation?: Quaternion): this;
    removeShape(shape: Shape): this;
    applyForce(force: Vec3, relativePoint?: Vec3): void;
    applyImpulse(impulse: Vec3, relativePoint?: Vec3): void;
    applyLocalForce(localForce: Vec3, localPoint?: Vec3): void;
    applyLocalImpulse(localImpulse: Vec3, localPoint?: Vec3): void;
    sleep(): void;
    wakeUp(): void;
    addEventListener(type: string, listener: (event: { type: string; body?: Body; contact?: unknown }) => void): void;
    removeEventListener(type: string, listener: Function): void;

    static DYNAMIC: number;
    static STATIC: number;
    static KINEMATIC: number;
  }

  // Constraints

  export class Constraint {
    bodyA: Body;
    bodyB: Body;
    enable(): void;
    disable(): void;
  }

  export class PointToPointConstraint extends Constraint {
    constructor(bodyA: Body, pivotA: Vec3, bodyB: Body, pivotB: Vec3, maxForce?: number);
  }

  export class DistanceConstraint extends Constraint {
    constructor(bodyA: Body, bodyB: Body, distance?: number, maxForce?: number);
  }

  export class HingeConstraint extends Constraint {
    constructor(bodyA: Body, bodyB: Body, options?: {
      pivotA?: Vec3;
      pivotB?: Vec3;
      axisA?: Vec3;
      axisB?: Vec3;
      maxForce?: number;
    });
    enableMotor(): void;
    disableMotor(): void;
    setMotorSpeed(speed: number): void;
    setMotorMaxForce(force: number): void;
  }

  export class LockConstraint extends Constraint {
    constructor(bodyA: Body, bodyB: Body, options?: { maxForce?: number });
  }

  export class Spring {
    bodyA: Body;
    bodyB: Body;
    restLength: number;
    stiffness: number;
    damping: number;
    constructor(bodyA: Body, bodyB: Body, options?: {
      restLength?: number;
      stiffness?: number;
      damping?: number;
      localAnchorA?: Vec3;
      localAnchorB?: Vec3;
    });
    applyForce(): void;
  }

  // World

  interface WorldOptions {
    gravity?: Vec3;
    allowSleep?: boolean;
    broadphase?: unknown;
    solver?: unknown;
  }

  export class World {
    gravity: Vec3;
    bodies: Body[];
    allowSleep: boolean;
    broadphase: unknown;
    solver: unknown;

    constructor(options?: WorldOptions);
    addBody(body: Body): void;
    removeBody(body: Body): void;
    addConstraint(constraint: Constraint): void;
    removeConstraint(constraint: Constraint): void;
    addContactMaterial(contactMaterial: ContactMaterial): void;
    step(dt: number, timeSinceLastCalled?: number, maxSubSteps?: number): void;
    addEventListener(type: string, listener: (event: { type: string }) => void): void;
    removeEventListener(type: string, listener: Function): void;
  }

  // Broadphase

  export class NaiveBroadphase {
    constructor();
  }

  export class SAPBroadphase {
    constructor(world?: World);
  }

  // Raycast

  export class Ray {
    from: Vec3;
    to: Vec3;
    constructor(from?: Vec3, to?: Vec3);
  }

  export class RaycastResult {
    hasHit: boolean;
    hitPointWorld: Vec3;
    hitNormalWorld: Vec3;
    body: Body | null;
    distance: number;
    reset(): void;
  }
}

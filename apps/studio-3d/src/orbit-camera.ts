/**
 * orbit-camera.ts — hand-rolled orbit / pan / dolly controller.
 *
 * `three/examples/jsm/controls/OrbitControls` is NOT available in
 * `@bundled/three` (core-only re-export), so this is our minimal equivalent.
 *
 *   LMB drag              orbit
 *   RMB drag / Shift+LMB  pan
 *   MMB drag              pan
 *   wheel / trackpad      dolly (delta-mode normalised, clamped)
 *   double click          frame the whole scene
 *
 * Inertial damping on all three axes. `frameObject()` fits the camera to a
 * bounding sphere — used by the F key and the 'frame all' button.
 */
import * as THREE from '@bundled/three';

type Mode = 'none' | 'orbit' | 'pan';

const EPS = 1e-6;
const MIN_PHI = 0.02;
const MAX_PHI = Math.PI - 0.02;

export class OrbitCamera {
  readonly target = new THREE.Vector3();
  enabled = true;
  damping = 0.18;
  rotateSpeed = 0.0045;
  panSpeed = 1;
  zoomSpeed = 1;
  minDistance = 0.02;
  maxDistance = 5000;

  private cam: THREE.PerspectiveCamera;
  private dom: HTMLElement;
  private mode: Mode = 'none';
  private pointerId = -1;
  private lastX = 0;
  private lastY = 0;

  // spherical state around `target`
  private theta = Math.PI * 0.28;
  private phi = Math.PI * 0.36;
  private radius = 8;

  // pending (damped) deltas
  private dTheta = 0;
  private dPhi = 0;
  private dScale = 1;
  private panDelta = new THREE.Vector3();

  private dirty = true;
  private onDoubleClick?: () => void;

  private readonly _v = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.cam = camera;
    this.dom = dom;
    dom.style.touchAction = 'none';

    dom.addEventListener('pointerdown', this.handlePointerDown);
    dom.addEventListener('pointermove', this.handlePointerMove);
    dom.addEventListener('pointerup', this.handlePointerUp);
    dom.addEventListener('pointercancel', this.handlePointerUp);
    dom.addEventListener('wheel', this.handleWheel, { passive: false });
    dom.addEventListener('contextmenu', this.handleContextMenu);
    dom.addEventListener('dblclick', this.handleDoubleClick);

    this.syncFromCamera();
  }

  setDoubleClickHandler(fn: () => void): void {
    this.onDoubleClick = fn;
  }

  /** Adopt whatever position the camera currently has as the orbit state. */
  syncFromCamera(): void {
    const offset = this._v.copy(this.cam.position).sub(this.target);
    this.radius = Math.max(offset.length(), EPS);
    this.theta = Math.atan2(offset.x, offset.z);
    this.phi = Math.acos(THREE.MathUtils.clamp(offset.y / this.radius, -1, 1));
    this.dirty = true;
  }

  private handleContextMenu = (e: Event) => {
    e.preventDefault();
  };

  private handleDoubleClick = () => {
    this.onDoubleClick?.();
  };

  private handlePointerDown = (e: PointerEvent) => {
    if (!this.enabled || this.mode !== 'none') return;
    if (e.button === 0) this.mode = e.shiftKey ? 'pan' : 'orbit';
    else if (e.button === 1 || e.button === 2) this.mode = 'pan';
    else return;
    this.pointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    e.preventDefault();
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (this.mode === 'none' || e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.mode === 'orbit') {
      this.dTheta -= dx * this.rotateSpeed * 2 * Math.PI * 0.16;
      this.dPhi -= dy * this.rotateSpeed * 2 * Math.PI * 0.16;
    } else {
      this.pan(dx, dy);
    }
    this.dirty = true;
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.mode = 'none';
    this.pointerId = -1;
    try {
      this.dom.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  /**
   * Trackpads emit dozens of tiny pixel deltas; mice emit ±100-ish line/pixel
   * jumps. Normalise to "notches" and clamp so one flick never teleports.
   */
  private handleWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const px = THREE.MathUtils.clamp(e.deltaY * unit, -240, 240);
    const notches = px / 120;
    this.dScale *= Math.pow(1.18, notches * this.zoomSpeed);
    this.dirty = true;
  };

  private pan(dx: number, dy: number): void {
    const el = this.dom;
    const h = el.clientHeight || 1;
    // world units covered by the viewport height at the target distance
    const worldPerPx =
      (2 * this.radius * Math.tan(((this.cam.fov / 2) * Math.PI) / 180)) / h;
    this._m.copy(this.cam.matrix);
    const right = this._v.set(this._m.elements[0], this._m.elements[1], this._m.elements[2]);
    this.panDelta.addScaledVector(right, -dx * worldPerPx * this.panSpeed);
    const up = this._v.set(this._m.elements[4], this._m.elements[5], this._m.elements[6]);
    this.panDelta.addScaledVector(up, dy * worldPerPx * this.panSpeed);
  }

  /** Advance damping and write the camera. Returns true if anything moved. */
  update(): boolean {
    const k = THREE.MathUtils.clamp(this.damping, 0.02, 1);
    const moving =
      Math.abs(this.dTheta) > 1e-5 ||
      Math.abs(this.dPhi) > 1e-5 ||
      Math.abs(this.dScale - 1) > 1e-5 ||
      this.panDelta.lengthSq() > 1e-10;

    if (moving) {
      this.theta += this.dTheta * k;
      this.phi = THREE.MathUtils.clamp(this.phi + this.dPhi * k, MIN_PHI, MAX_PHI);
      this.radius = THREE.MathUtils.clamp(
        this.radius * (1 + (this.dScale - 1) * k),
        this.minDistance,
        this.maxDistance,
      );
      this.target.addScaledVector(this.panDelta, k);

      const decay = 1 - k;
      this.dTheta *= decay;
      this.dPhi *= decay;
      this.dScale = 1 + (this.dScale - 1) * decay;
      this.panDelta.multiplyScalar(decay);
      this.dirty = true;
    }

    if (!this.dirty) return false;
    this.dirty = false;

    const sinPhi = Math.sin(this.phi);
    this.cam.position.set(
      this.target.x + this.radius * sinPhi * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sinPhi * Math.cos(this.theta),
    );
    this.cam.lookAt(this.target);
    this.cam.updateMatrixWorld();
    return true;
  }

  /** Fit the camera to an object's bounding sphere. */
  frameObject(obj: THREE.Object3D, fit = 1.25): boolean {
    const box = new THREE.Box3();
    box.setFromObject(obj);
    return this.frameBox(box, fit);
  }

  frameBox(box: THREE.Box3, fit = 1.25): boolean {
    if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return false;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 0.05);
    const vFov = (this.cam.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.cam.aspect);
    const dist = (r / Math.sin(Math.min(vFov, hFov) / 2)) * fit;

    this.target.copy(sphere.center);
    this.radius = THREE.MathUtils.clamp(dist, this.minDistance, this.maxDistance);
    this.cam.near = Math.max(r / 500, 0.001);
    this.cam.far = Math.max(dist + r * 20, 100);
    this.cam.updateProjectionMatrix();

    this.dTheta = 0;
    this.dPhi = 0;
    this.dScale = 1;
    this.panDelta.set(0, 0, 0);
    this.dirty = true;
    return true;
  }

  reset(): void {
    this.target.set(0, 0, 0);
    this.theta = Math.PI * 0.28;
    this.phi = Math.PI * 0.36;
    this.radius = 8;
    this.dirty = true;
  }

  get distance(): number {
    return this.radius;
  }

  dispose(): void {
    const dom = this.dom;
    dom.removeEventListener('pointerdown', this.handlePointerDown);
    dom.removeEventListener('pointermove', this.handlePointerMove);
    dom.removeEventListener('pointerup', this.handlePointerUp);
    dom.removeEventListener('pointercancel', this.handlePointerUp);
    dom.removeEventListener('wheel', this.handleWheel);
    dom.removeEventListener('contextmenu', this.handleContextMenu);
    dom.removeEventListener('dblclick', this.handleDoubleClick);
  }
}

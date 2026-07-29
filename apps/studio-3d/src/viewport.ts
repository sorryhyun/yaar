/**
 * viewport.ts — renderer, lighting rig, helpers, render loop, PNG capture.
 */
import * as THREE from '@bundled/three';
import { OrbitCamera } from './orbit-camera';

const BG = 0x161b22; // --yaar-bg
const GRID_MAJOR = 0x4a5563;
const GRID_MINOR = 0x2b3138;
const SELECT_COLOR = 0x539bf5; // --yaar-accent

/** Cap at 1.5×: above that the capture composite and GPU cost both suffer. */
function pixelRatio(): number {
  const dpr = window.devicePixelRatio;
  return Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 1.5);
}

export interface ViewportStats {
  fps: number;
  drawCalls: number;
  triangles: number;
}

export class Viewport {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly orbit: OrbitCamera;

  private container: HTMLElement;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private selectionBox: THREE.Box3Helper;
  private selectionTarget: THREE.Object3D | null = null;
  private contentRoot: THREE.Object3D | null = null;
  private ro: ResizeObserver;
  private raf = 0;
  private disposed = false;

  private frames = 0;
  private fpsClock = performance.now();
  private fps = 0;
  onStats?: (s: ViewportStats) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      // required so the canvas survives window capture / toDataURL
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(pixelRatio());
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(BG, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    this.scene.background = new THREE.Color(BG);
    this.scene.fog = null;

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 4000);
    this.camera.position.set(4, 3, 6);

    this.orbit = new OrbitCamera(this.camera, canvas);
    this.orbit.syncFromCamera();

    // --- studio lighting: key / fill / rim + hemisphere ambient -------
    const hemi = new THREE.HemisphereLight(0xdfe7f2, 0x1a1f27, 0.85);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(5, 8, 6);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xa8c6ff, 0.85);
    fill.position.set(-6, 2, 4);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffd9a8, 1.1);
    rim.position.set(-3, 5, -7);
    this.scene.add(rim);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    // --- helpers ------------------------------------------------------
    this.grid = new THREE.GridHelper(20, 20, GRID_MAJOR, GRID_MINOR);
    const gridMat = this.grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.55;
    (this.grid as unknown as { renderOrder: number }).renderOrder = -1;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(1.2);
    this.scene.add(this.axes);

    this.selectionBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(SELECT_COLOR));
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);

    this.orbit.setDoubleClickHandler(() => this.frameAll());
    this.loop();
  }

  attach(root: THREE.Object3D): void {
    if (this.contentRoot) this.scene.remove(this.contentRoot);
    this.contentRoot = root;
    this.scene.add(root);
  }

  resize(): void {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    // Re-assert the ratio: the drawing buffer must track the CSS box, or window
    // capture composites the canvas at its natural size and crops the view.
    this.renderer.setPixelRatio(pixelRatio());
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v;
    this.axes.visible = v;
  }

  get gridVisible(): boolean {
    return this.grid.visible;
  }

  setSelection(obj: THREE.Object3D | null): void {
    this.selectionTarget = obj;
    this.selectionBox.visible = !!obj;
  }

  private updateSelectionBox(): void {
    if (!this.selectionTarget || !this.selectionBox.visible) return;
    const box = (this.selectionBox as unknown as { box: THREE.Box3 }).box;
    box.setFromObject(this.selectionTarget);
    if (box.isEmpty()) this.selectionBox.visible = false;
  }

  frameAll(): boolean {
    if (!this.contentRoot) return false;
    const box = new THREE.Box3().setFromObject(this.contentRoot);
    if (box.isEmpty()) {
      this.orbit.reset();
      return false;
    }
    return this.orbit.frameBox(box);
  }

  frameObject(obj: THREE.Object3D): boolean {
    return this.orbit.frameObject(obj);
  }

  /**
   * Render one frame right now and return a PNG data URL.
   *
   * Renders at `minWidth` even when the window is small, so a PNG saved from a
   * narrow panel is still usable. The drawing buffer is resized without
   * touching the CSS box and restored immediately; the aspect ratio, and so the
   * framing, is unchanged.
   */
  captureDataURL(minWidth = 1280): string {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    const scale = Math.max(1, Math.min(4, minWidth / w));
    if (scale > 1) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(Math.round(w * scale), Math.round(h * scale), false);
    }
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    if (scale > 1) this.resize();
    return url;
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.orbit.update();
    this.updateSelectionBox();
    this.renderer.render(this.scene, this.camera);

    this.frames += 1;
    const now = performance.now();
    if (now - this.fpsClock >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsClock));
      this.frames = 0;
      this.fpsClock = now;
      this.onStats?.({
        fps: this.fps,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      });
    }
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.orbit.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.axes.geometry.dispose();
    (this.axes.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

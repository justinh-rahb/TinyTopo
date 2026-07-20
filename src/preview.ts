import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface PreviewItem {
  geometry: THREE.BufferGeometry;
  color: number;
}

/** Three.js viewport for the generated model. Geometries are Z-up mm. */
export class Preview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private group = new THREE.Group();

  constructor(private canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer lets snapshot() read pixels for 3MF thumbnails.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(0x0b0d0f);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    // Model space is Z-up; rotate into Three's Y-up for display.
    this.group.rotation.x = -Math.PI / 2;
    this.scene.add(this.group);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.2);
    this.scene.add(sun);

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Render layered geometries; the first item is used to frame the camera. */
  show(items: PreviewItem[]): void {
    this.clear();
    items.forEach(({ geometry, color }, i) => {
      // Bodies share coplanar faces (base/terrain walls, embedded slabs);
      // bias later layers slightly toward the camera to avoid z-fighting.
      const material = new THREE.MeshStandardMaterial({
        color,
        polygonOffset: true,
        polygonOffsetFactor: -i,
        polygonOffsetUnits: -i,
      });
      this.group.add(new THREE.Mesh(geometry, material));
    });
    if (items.length > 0) this.fit(items[0].geometry);
  }

  private fit(reference: THREE.BufferGeometry): void {
    reference.computeBoundingBox();
    const box = reference.boundingBox;
    if (!box) return;
    const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
    const height = box.max.z - box.min.z;
    this.controls.target.set(0, height / 2, 0);
    this.camera.position.set(size * 0.55, size * 0.7, size * 0.95);
    this.camera.near = size / 100;
    this.camera.far = size * 20;
    this.camera.updateProjectionMatrix();
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  /** Square PNG snapshot of the current view (for 3MF cover thumbnails). */
  async snapshot(sizePx: number): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    const src = this.canvas;
    const side = Math.min(src.width, src.height);
    const out = document.createElement('canvas');
    out.width = sizePx;
    out.height = sizePx;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, sizePx, sizePx);
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const { clientWidth: w, clientHeight: h } = parent;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

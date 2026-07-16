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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
    for (const { geometry, color } of items) {
      this.group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color })));
    }
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

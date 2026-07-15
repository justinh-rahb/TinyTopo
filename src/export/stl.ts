import * as THREE from 'three';

/**
 * Serialize geometries (Z-up, millimeters) into a binary STL file.
 * Geometry positions are used as-is — no scene transforms are applied.
 */
export function toBinaryStl(geometries: THREE.BufferGeometry[]): ArrayBuffer {
  let triangleCount = 0;
  for (const g of geometries) {
    const index = g.index;
    triangleCount += (index ? index.count : g.getAttribute('position').count) / 3;
  }

  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 80).set(new TextEncoder().encode('TinyTopo binary STL'));
  view.setUint32(80, triangleCount, true);

  let offset = 84;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const index = g.index;
    const count = index ? index.count : pos.count;
    const vertexAt = (i: number, v: THREE.Vector3) => {
      const vi = index ? index.getX(i) : i;
      v.fromBufferAttribute(pos, vi);
    };

    for (let i = 0; i < count; i += 3) {
      vertexAt(i, a);
      vertexAt(i + 1, b);
      vertexAt(i + 2, c);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      n.crossVectors(ab, ac).normalize();

      view.setFloat32(offset, n.x, true);
      view.setFloat32(offset + 4, n.y, true);
      view.setFloat32(offset + 8, n.z, true);
      let vo = offset + 12;
      for (const v of [a, b, c]) {
        view.setFloat32(vo, v.x, true);
        view.setFloat32(vo + 4, v.y, true);
        view.setFloat32(vo + 8, v.z, true);
        vo += 12;
      }
      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
  }
  return buffer;
}

export function downloadStl(geometries: THREE.BufferGeometry[], filename: string): void {
  const blob = new Blob([toBinaryStl(geometries)], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

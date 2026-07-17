import * as THREE from 'three';
import { Bounds, ModelSpace } from '../geo';
import type { Dem } from '../elevation';

export interface TerrainGrid {
  /** Elevation samples in meters, row-major, south-to-north rows. */
  elev: Float32Array;
  cols: number;
  rows: number;
  lons: Float64Array;
  lats: Float64Array;
  minElevation: number;
}

/** Sample the DEM into a regular grid over the bounds. */
export function sampleGrid(bounds: Bounds, dem: Dem, widthMm: number, depthMm: number): TerrainGrid {
  // Grid pitch also sets overlay edge resolution (polygons rasterize onto
  // this grid), so keep cells at or below nozzle size (~0.4mm).
  const density = 2.4; // vertices per model millimeter
  const cols = clamp(Math.round(widthMm * density), 48, 320);
  const rows = clamp(Math.round(depthMm * density), 48, 320);

  const lons = new Float64Array(cols);
  const lats = new Float64Array(rows);
  for (let i = 0; i < cols; i++) lons[i] = bounds.west + ((bounds.east - bounds.west) * i) / (cols - 1);
  for (let j = 0; j < rows; j++) lats[j] = bounds.south + ((bounds.north - bounds.south) * j) / (rows - 1);

  const elev = new Float32Array(cols * rows);
  let min = Infinity;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const e = dem.sample(lons[i], lats[j]);
      elev[j * cols + i] = e;
      if (e < min) min = e;
    }
  }
  return { elev, cols, rows, lons, lats, minElevation: min };
}

/** How far the terrain slab sinks into the base, in mm, to guarantee overlap. */
const EMBED_MM = 0.6;

/**
 * Build the base plinth: a plain box from Z=0 to the base height, spanning
 * the same footprint as the terrain grid. Separate body = separately
 * colorable in multi-material slicers.
 */
export function buildBase(grid: TerrainGrid, space: ModelSpace): THREE.BufferGeometry {
  const x0 = space.x(grid.lons[0]);
  const x1 = space.x(grid.lons[grid.cols - 1]);
  const y0 = space.y(grid.lats[0]);
  const y1 = space.y(grid.lats[grid.rows - 1]);
  const z1 = space.baseMm;

  const positions: number[] = [];
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ) => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  };

  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // top (+Z)
  quad([x0, y1, 0], [x1, y1, 0], [x1, y0, 0], [x0, y0, 0]); // bottom (-Z)
  quad([x0, y0, 0], [x1, y0, 0], [x1, y0, z1], [x0, y0, z1]); // south
  quad([x1, y0, 0], [x1, y1, 0], [x1, y1, z1], [x1, y0, z1]); // east
  quad([x1, y1, 0], [x0, y1, 0], [x0, y1, z1], [x1, y1, z1]); // north
  quad([x0, y1, 0], [x0, y0, 0], [x0, y0, z1], [x0, y1, z1]); // west

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build a watertight terrain slab: relief surface on top, vertical walls
 * down to just below the base top (embedding into the base body), and a
 * bottom face triangulated against the same perimeter vertices
 * (no T-junctions).
 */
export function buildTerrain(grid: TerrainGrid, space: ModelSpace): THREE.BufferGeometry {
  const bottomZ = Math.max(0, space.baseMm - EMBED_MM);
  const { elev, cols, rows, lons, lats } = grid;
  const positions: number[] = [];

  const topX = new Float32Array(cols);
  for (let i = 0; i < cols; i++) topX[i] = space.x(lons[i]);
  const topY = new Float32Array(rows);
  for (let j = 0; j < rows; j++) topY[j] = space.y(lats[j]);
  const topZ = (i: number, j: number) => space.z(elev[j * cols + i]);

  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };

  // Top surface (counter-clockwise seen from above = +Z normals).
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const x0 = topX[i], x1 = topX[i + 1];
      const y0 = topY[j], y1 = topY[j + 1];
      const z00 = topZ(i, j), z10 = topZ(i + 1, j), z01 = topZ(i, j + 1), z11 = topZ(i + 1, j + 1);
      tri(x0, y0, z00, x1, y0, z10, x1, y1, z11);
      tri(x0, y0, z00, x1, y1, z11, x0, y1, z01);
    }
  }

  // Perimeter loop, counter-clockwise seen from above, starting SW corner.
  const loop: Array<[number, number, number]> = [];
  for (let i = 0; i < cols; i++) loop.push([topX[i], topY[0], topZ(i, 0)]); // south edge W->E
  for (let j = 1; j < rows; j++) loop.push([topX[cols - 1], topY[j], topZ(cols - 1, j)]); // east edge S->N
  for (let i = cols - 2; i >= 0; i--) loop.push([topX[i], topY[rows - 1], topZ(i, rows - 1)]); // north E->W
  for (let j = rows - 2; j >= 1; j--) loop.push([topX[0], topY[j], topZ(0, j)]); // west N->S

  // Walls down to the embedded bottom (outward normals).
  for (let k = 0; k < loop.length; k++) {
    const [ax, ay, az] = loop[k];
    const [bx, by, bz] = loop[(k + 1) % loop.length];
    tri(ax, ay, bottomZ, bx, by, bottomZ, bx, by, bz);
    tri(ax, ay, bottomZ, bx, by, bz, ax, ay, az);
  }

  // Bottom: fan from the center to every perimeter vertex (normals down).
  for (let k = 0; k < loop.length; k++) {
    const [ax, ay] = loop[k];
    const [bx, by] = loop[(k + 1) % loop.length];
    tri(0, 0, bottomZ, bx, by, bottomZ, ax, ay, bottomZ);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

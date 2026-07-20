import * as THREE from 'three';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { Bounds, ModelSpace } from '../geo';
import type { Dem } from '../elevation';
import { clipRing } from './clip';
import type { RoadLine } from '../overpass';
import type { TerrainGrid } from './terrain';

/**
 * Surface overlays (roads, water, greenery) are thin slabs draped over the
 * terrain: the top follows the relief at a small lift above the surface, and
 * the slab extends downward far enough to embed into the terrain, so each
 * solid is watertight on its own and prints as a colored surface layer.
 */
interface SlabStyle {
  liftMm: number;
  thicknessMm: number;
}

export const ROAD_STYLE: SlabStyle = { liftMm: 0.3, thicknessMm: 1.2 };
export const WATER_STYLE: SlabStyle = { liftMm: 0.05, thicknessMm: 1.2 };
export const GREEN_STYLE: SlabStyle = { liftMm: 0.15, thicknessMm: 1.2 };

const MIN_AREA_MM2 = 0.8;
/** Cell size for draping polygons over relief; smaller follows terrain closer. */
const DRAPE_CELL_MM = 5;
/** Terrain height variation below which a single flat slab is close enough. */
const FLAT_ENOUGH_MM = 0.5;

/**
 * Build one geometry from polygonal features (water, green, aprons) by
 * painting them onto the terrain grid: polygons rasterize to supersampled
 * coverage, then marching squares extracts interpolated boundaries. Overlay
 * vertices sample the same relief field as the terrain, plus lift, so there
 * is no poke-through or separate boundary shell to seam.
 * Features smaller than a couple of grid cells are draped as slabs instead
 * so pitches and ponds don't vanish in rasterization.
 */
/** Subcells per terrain-grid cell edge for coverage supersampling. */
const SS = 4;

export interface OverlayResult {
  geometry: THREE.BufferGeometry | null;
  /** Supersampled coverage this layer claimed — pass as `exclude` below it. */
  mask: Uint8Array;
}

export function buildPolygonOverlay(
  features: Feature<Polygon | MultiPolygon>[],
  bounds: Bounds,
  space: ModelSpace,
  dem: Dem,
  grid: TerrainGrid,
  style: SlabStyle,
  exclude?: Uint8Array,
): OverlayResult {
  const { cols, rows, lons, lats } = grid;
  const cellsX = cols - 1;
  const cellsY = rows - 1;
  const subCols = cellsX * SS;
  const subRows = cellsY * SS;
  const mask = new Uint8Array(subCols * subRows);
  const gx = (lon: number) => ((lon - lons[0]) / (lons[cols - 1] - lons[0])) * cellsX;
  const gy = (lat: number) => ((lat - lats[0]) / (lats[rows - 1] - lats[0])) * cellsY;

  const positions: number[] = [];
  for (const feature of features) {
    const polygons: Position[][][] =
      feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const rings of polygons) {
      const outer = clipRing(rings[0] ?? [], bounds);
      if (outer.length < 3) continue;
      const holes = rings
        .slice(1)
        .map((h) => clipRing(h, bounds))
        .filter((h) => h.length >= 3);

      let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (const [lon, lat] of outer) {
        const x = gx(lon), y = gy(lat);
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
      if (xMax - xMin < 2 || yMax - yMin < 2) {
        appendSlab(positions, outer, holes, space, dem, style, 0.1);
        continue;
      }

      // Even-odd scanline fill across all rings (outer + holes), supersampled
      // inside each terrain cell. The final mesh is still emitted against the
      // terrain grid, but the boundary crossings below get subcell precision.
      const gridRings = [outer, ...holes].map((r) => r.map(([lon, lat]) => [gx(lon), gy(lat)]));
      const j0 = Math.max(0, Math.floor(yMin * SS - 0.5));
      const j1 = Math.min(subRows - 1, Math.ceil(yMax * SS - 0.5));
      for (let j = j0; j <= j1; j++) {
        const yc = (j + 0.5) / SS;
        const crossings: number[] = [];
        for (const ring of gridRings) {
          for (let k = 0; k < ring.length; k++) {
            const [ax, ay] = ring[k];
            const [bx, by] = ring[(k + 1) % ring.length];
            if (ay <= yc !== by <= yc) {
              crossings.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
            }
          }
        }
        crossings.sort((a, b) => a - b);
        for (let k = 0; k + 1 < crossings.length; k += 2) {
          const i0 = Math.max(0, Math.ceil(crossings[k] * SS - 0.5));
          const i1 = Math.min(subCols - 1, Math.floor(crossings[k + 1] * SS - 0.5));
          for (let i = i0; i <= i1; i++) mask[j * subCols + i] = 1;
        }
      }
    }
  }

  // Higher-priority layers (e.g. water under greenery) keep their cells.
  if (exclude) {
    for (let k = 0; k < mask.length; k++) if (exclude[k]) mask[k] = 0;
  }

  emitMarchingMask(positions, mask, grid, space, style);
  return { geometry: toGeometry(positions), mask };
}

/** Emit supersampled coverage as one watertight terrain-following layer. */
function emitMarchingMask(
  out: number[],
  mask: Uint8Array,
  grid: TerrainGrid,
  space: ModelSpace,
  style: SlabStyle,
): void {
  const { cols, rows, lons, lats, elev } = grid;
  const cellsX = cols - 1;
  const cellsY = rows - 1;
  const subCols = cellsX * SS;
  const subRows = cellsY * SS;
  const X = new Float32Array(cols);
  for (let i = 0; i < cols; i++) X[i] = space.x(lons[i]);
  const Y = new Float32Array(rows);
  for (let j = 0; j < rows; j++) Y[j] = space.y(lats[j]);
  const atSub = (i: number, j: number) => (j >= 0 && j < subRows && i >= 0 && i < subCols ? mask[j * subCols + i] : 0);
  const coverage = (i: number, j: number) => {
    let n = 0;
    for (let sy = j * SS; sy < (j + 1) * SS; sy++) {
      for (let sx = i * SS; sx < (i + 1) * SS; sx++) n += atSub(sx, sy);
    }
    return n / (SS * SS);
  };
  const scalar = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0;
      let n = 0;
      for (let cy = j - 1; cy <= j; cy++) {
        for (let cx = i - 1; cx <= i; cx++) {
          if (cx < 0 || cy < 0 || cx >= cellsX || cy >= cellsY) continue;
          sum += coverage(cx, cy);
          n++;
        }
      }
      scalar[j * cols + i] = n === 0 ? 0 : sum / n;
    }
  }

  interface Vertex {
    x: number;
    y: number;
    zTop: number;
    zBot: number;
  }
  const vertices: Vertex[] = [];
  const vertexIds = new Map<string, number>();
  const directed = new Set<string>();
  const iso = 0.5;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const edgeT = (a: number, b: number) => {
    const d = b - a;
    return Math.abs(d) < 1e-9 ? 0.5 : THREE.MathUtils.clamp((iso - a) / d, 0, 1);
  };
  const sampleVertex = (gx: number, gy: number): Vertex => {
    const i0 = Math.min(cellsX - 1, Math.max(0, Math.floor(gx)));
    const j0 = Math.min(cellsY - 1, Math.max(0, Math.floor(gy)));
    const tx = gx - i0;
    const ty = gy - j0;
    const x = lerp(X[i0], X[i0 + 1], tx);
    const y = lerp(Y[j0], Y[j0 + 1], ty);
    const z00 = elev[j0 * cols + i0];
    const z10 = elev[j0 * cols + i0 + 1];
    const z01 = elev[(j0 + 1) * cols + i0];
    const z11 = elev[(j0 + 1) * cols + i0 + 1];
    const zMeters = lerp(lerp(z00, z10, tx), lerp(z01, z11, tx), ty);
    const zTop = space.z(zMeters) + style.liftMm;
    return { x, y, zTop, zBot: Math.max(0, zTop - style.thicknessMm) };
  };
  const vertexId = (key: string, gx: number, gy: number) => {
    const existing = vertexIds.get(key);
    if (existing !== undefined) return existing;
    const id = vertices.length;
    vertices.push(sampleVertex(gx, gy));
    vertexIds.set(key, id);
    return id;
  };
  const corner = (i: number, j: number) => vertexId(`g:${i}:${j}`, i, j);
  const bottom = (i: number, j: number, v0: number, v1: number) => {
    const t = edgeT(v0, v1);
    return vertexId(`h:${i}:${j}`, i + t, j);
  };
  const right = (i: number, j: number, v0: number, v1: number) => {
    const t = edgeT(v0, v1);
    return vertexId(`v:${i + 1}:${j}`, i + 1, j + t);
  };
  const top = (i: number, j: number, v0: number, v1: number) => {
    const t = edgeT(v0, v1);
    return vertexId(`h:${i}:${j + 1}`, i + t, j + 1);
  };
  const left = (i: number, j: number, v0: number, v1: number) => {
    const t = edgeT(v0, v1);
    return vertexId(`v:${i}:${j}`, i, j + t);
  };

  const pushTri = (a: number, b: number, c: number, topFace: boolean) => {
    const ids = topFace ? [a, b, c] : [c, b, a];
    for (const id of ids) {
      const v = vertices[id];
      out.push(v.x, v.y, topFace ? v.zTop : v.zBot);
    }
  };
  const emitPoly = (poly: number[]) => {
    if (poly.length < 3) return;
    for (let k = 1; k + 1 < poly.length; k++) {
      const a = poly[0], b = poly[k], c = poly[k + 1];
      pushTri(a, b, c, true);
      pushTri(a, b, c, false);
      directed.add(`${a}_${b}`).add(`${b}_${c}`).add(`${c}_${a}`);
    }
  };

  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const v00 = scalar[j * cols + i];
      const v10 = scalar[j * cols + i + 1];
      const v11 = scalar[(j + 1) * cols + i + 1];
      const v01 = scalar[(j + 1) * cols + i];
      switch ((v00 >= iso ? 1 : 0) | (v10 >= iso ? 2 : 0) | (v11 >= iso ? 4 : 0) | (v01 >= iso ? 8 : 0)) {
        case 0: break;
        case 1: emitPoly([corner(i, j), bottom(i, j, v00, v10), left(i, j, v00, v01)]); break;
        case 2: emitPoly([corner(i + 1, j), right(i, j, v10, v11), bottom(i, j, v00, v10)]); break;
        case 3: emitPoly([corner(i, j), corner(i + 1, j), right(i, j, v10, v11), left(i, j, v00, v01)]); break;
        case 4: emitPoly([corner(i + 1, j + 1), top(i, j, v01, v11), right(i, j, v10, v11)]); break;
        case 5:
          emitPoly([corner(i, j), bottom(i, j, v00, v10), left(i, j, v00, v01)]);
          emitPoly([corner(i + 1, j + 1), top(i, j, v01, v11), right(i, j, v10, v11)]);
          break;
        case 6: emitPoly([corner(i + 1, j), corner(i + 1, j + 1), top(i, j, v01, v11), bottom(i, j, v00, v10)]); break;
        case 7: emitPoly([corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), top(i, j, v01, v11), left(i, j, v00, v01)]); break;
        case 8: emitPoly([corner(i, j + 1), left(i, j, v00, v01), top(i, j, v01, v11)]); break;
        case 9: emitPoly([corner(i, j), bottom(i, j, v00, v10), top(i, j, v01, v11), corner(i, j + 1)]); break;
        case 10:
          emitPoly([corner(i + 1, j), right(i, j, v10, v11), bottom(i, j, v00, v10)]);
          emitPoly([corner(i, j + 1), left(i, j, v00, v01), top(i, j, v01, v11)]);
          break;
        case 11: emitPoly([corner(i, j), corner(i + 1, j), right(i, j, v10, v11), top(i, j, v01, v11), corner(i, j + 1)]); break;
        case 12: emitPoly([corner(i, j + 1), left(i, j, v00, v01), right(i, j, v10, v11), corner(i + 1, j + 1)]); break;
        case 13: emitPoly([corner(i, j), bottom(i, j, v00, v10), right(i, j, v10, v11), corner(i + 1, j + 1), corner(i, j + 1)]); break;
        case 14: emitPoly([corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1), left(i, j, v00, v01), bottom(i, j, v00, v10)]); break;
        case 15: emitPoly([corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)]); break;
      }
    }
  }

  for (const key of directed) {
    const [a, b] = key.split('_').map(Number);
    if (directed.has(`${b}_${a}`)) continue;
    const va = vertices[a], vb = vertices[b];
    out.push(va.x, va.y, va.zBot, vb.x, vb.y, vb.zBot, vb.x, vb.y, vb.zTop);
    out.push(va.x, va.y, va.zBot, vb.x, vb.y, vb.zTop, va.x, va.y, va.zTop);
  }
}

/** Build one geometry from buffered road/rail centerlines. */
export function buildRoadOverlay(
  roads: RoadLine[],
  bounds: Bounds,
  space: ModelSpace,
  dem: Dem,
  style: SlabStyle = ROAD_STYLE,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  for (const road of roads) {
    if (road.points.length < 2) continue;
    const ringMm = bufferLineMm(
      road.points.map(([lon, lat]) => [space.x(lon), space.y(lat)]),
      (road.widthM * space.mmPerMeter) / 2,
    );
    if (!ringMm) continue;
    // Back to lon/lat so the slab can be clipped and draped on the DEM.
    const ring = ringMm.map(([x, y]) => [space.lon(x), space.lat(y)] as Position);
    const clipped = clipRing(ring, bounds);
    if (clipped.length < 3) continue;
    appendSlabCelled(positions, clipped, [], space, dem, style);
  }
  return toGeometry(positions);
}

/**
 * Drape a polygon over relief by clipping it into grid cells that share one
 * watertight mesh. Large flat triangles no longer span hills, while matching
 * cell edges cancel so only the polygon's true perimeter receives walls.
 */
function appendSlabCelled(
  out: number[],
  outer: Position[],
  holes: Position[][],
  space: ModelSpace,
  dem: Dem,
  style: SlabStyle,
): void {
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const [lon, lat] of outer) {
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  const wMm = space.x(lonMax) - space.x(lonMin);
  const hMm = space.y(latMax) - space.y(latMin);

  // Small feature, or terrain that's flat under the bounding box: one slab.
  if (wMm <= DRAPE_CELL_MM * 1.5 && hMm <= DRAPE_CELL_MM * 1.5) {
    appendSlab(out, outer, holes, space, dem, style);
    return;
  }
  let zMin = Infinity, zMax = -Infinity;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const z = dem.sample(lonMin + ((lonMax - lonMin) * i) / 3, latMin + ((latMax - latMin) * j) / 3);
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
  }
  if ((zMax - zMin) * space.mmPerMeter * space.zFactor < FLAT_ENOUGH_MM) {
    appendSlab(out, outer, holes, space, dem, style);
    return;
  }

  const cellsX = Math.max(1, Math.ceil(wMm / DRAPE_CELL_MM));
  const cellsY = Math.max(1, Math.ceil(hMm / DRAPE_CELL_MM));
  const dLon = (lonMax - lonMin) / cellsX;
  const dLat = (latMax - latMin) / cellsY;
  const shared: SharedSlabMesh = { vertices: [], vertexIds: new Map(), directed: new Set() };
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const cell = {
        west: lonMin + dLon * cx,
        east: lonMin + dLon * (cx + 1),
        south: latMin + dLat * cy,
        north: latMin + dLat * (cy + 1),
      };
      const outerC = clipRing(outer, cell);
      if (outerC.length < 3) continue;
      const holesC = holes.map((h) => clipRing(h, cell)).filter((h) => h.length >= 3);
      appendSlab(out, outerC, holesC, space, dem, style, 0.05, shared);
    }
  }
  appendBoundaryWalls(out, shared.vertices, shared.directed);
}

/**
 * Buffer an open polyline (mm space) into a closed ring: offset both sides
 * with clamped miter joins and square caps.
 */
function bufferLineMm(pts: Array<[number, number]>, halfW: number): Array<[number, number]> | null {
  // Collapse consecutive duplicates that would break normal computation.
  const p: Array<[number, number]> = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) p.push(q);
  }
  if (p.length < 2) return null;

  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < p.length; i++) {
    const prev = p[Math.max(0, i - 1)];
    const next = p[Math.min(p.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    dx /= len;
    dy /= len;
    // Perpendicular (left of travel); clamp the miter to 3x half-width.
    let nx = -dy;
    let ny = dx;
    let scale = halfW;
    if (i > 0 && i < p.length - 1) {
      const d1x = p[i][0] - prev[0];
      const d1y = p[i][1] - prev[1];
      const l1 = Math.hypot(d1x, d1y);
      const cos = l1 > 1e-9 ? (d1x / l1) * dx + (d1y / l1) * dy : 1;
      const miter = 1 / Math.max(Math.sqrt((1 + cos) / 2), 1 / 3);
      scale = halfW * Math.min(miter, 3);
    }
    left.push([p[i][0] + nx * scale, p[i][1] + ny * scale]);
    right.push([p[i][0] - nx * scale, p[i][1] - ny * scale]);
  }
  if (left.length < 2) return null;
  return [...left, ...right.reverse()];
}

interface SlabVertex {
  x: number;
  y: number;
  zTop: number;
  zBot: number;
}

interface SharedSlabMesh {
  vertices: SlabVertex[];
  vertexIds: Map<string, number>;
  directed: Set<string>;
}

/** Triangulate + drape a polygon (with holes) and give it slab thickness. */
function appendSlab(
  out: number[],
  outer: Position[],
  holes: Position[][],
  space: ModelSpace,
  dem: Dem,
  style: SlabStyle,
  minAreaMm2: number = MIN_AREA_MM2,
  shared?: SharedSlabMesh,
): void {
  // Clipping can emit duplicate consecutive/closing vertices, and
  // triangulateShape mutates rings to drop them — sanitize first so our
  // parallel ring arrays stay aligned with the triangulation.
  outer = cleanRing(outer);
  holes = holes.map(cleanRing).filter((h) => h.length >= 3);
  if (outer.length < 3) return;
  const outerV2 = outer.map(([lon, lat]) => new THREE.Vector2(space.x(lon), space.y(lat)));
  if (Math.abs(signedArea(outerV2)) < minAreaMm2) return;

  // earcut convention: outer CCW, holes CW.
  const oRing = signedArea(outerV2) < 0 ? [...outer].reverse() : outer;
  const oV2 = signedArea(outerV2) < 0 ? [...outerV2].reverse() : outerV2;
  const hRings: Position[][] = [];
  const hV2: THREE.Vector2[][] = [];
  for (const h of holes) {
    const v2 = h.map(([lon, lat]) => new THREE.Vector2(space.x(lon), space.y(lat)));
    if (Math.abs(signedArea(v2)) < MIN_AREA_MM2) continue;
    hRings.push(signedArea(v2) > 0 ? [...h].reverse() : h);
    hV2.push(signedArea(v2) > 0 ? [...v2].reverse() : v2);
  }

  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(oV2, hV2);
  } catch {
    return;
  }
  if (faces.length === 0) return;

  const allRings = [oRing, ...hRings];
  const allV2 = [oV2, ...hV2];
  const flat: SlabVertex[] = [];
  for (let r = 0; r < allRings.length; r++) {
    for (let i = 0; i < allRings[r].length; i++) {
      const [lon, lat] = allRings[r][i];
      const zTop = space.z(dem.sample(lon, lat)) + style.liftMm;
      flat.push({
        x: allV2[r][i].x,
        y: allV2[r][i].y,
        zTop,
        zBot: Math.max(0, zTop - style.thicknessMm),
      });
    }
  }

  // Celled slabs share vertices and edge identities across clipping boundaries.
  // This keeps the terrain subdivision while allowing interior walls to cancel.
  const vertexIds = shared
    ? flat.map((v) => sharedVertexId(shared, v))
    : flat.map((_, i) => i);
  const vertices = shared ? vertexIds.map((id) => shared.vertices[id]) : flat;

  const tri = (a: number, b: number, c: number, top: boolean) => {
    const [va, vb, vc] = top ? [a, b, c] : [c, b, a];
    for (const i of [va, vb, vc]) {
      const v = vertices[i];
      out.push(v.x, v.y, top ? v.zTop : v.zBot);
    }
  };

  const directed = shared?.directed ?? new Set<string>();
  for (const [a, b, c] of faces) {
    tri(a, b, c, true);
    tri(a, b, c, false);
    const ai = vertexIds[a], bi = vertexIds[b], ci = vertexIds[c];
    directed.add(`${ai}_${bi}`).add(`${bi}_${ci}`).add(`${ci}_${ai}`);
  }

  if (!shared) appendBoundaryWalls(out, vertices, directed);
}

function sharedVertexId(shared: SharedSlabMesh, vertex: SlabVertex): number {
  // Adjacent clipping passes can differ by floating-point dust. A nanometre
  // in model space is far below useful geometry precision but joins the cells.
  const key = `${Math.round(vertex.x * 1e6)}_${Math.round(vertex.y * 1e6)}`;
  const existing = shared.vertexIds.get(key);
  if (existing !== undefined) return existing;
  const id = shared.vertices.length;
  shared.vertices.push(vertex);
  shared.vertexIds.set(key, id);
  return id;
}

/** Emit walls only on top-face edges that have no reverse partner. */
function appendBoundaryWalls(out: number[], vertices: SlabVertex[], directed: Set<string>): void {
  // Following emitted faces rather than input rings keeps the solid closed if
  // earcut drops a degenerate triangle. CCW top faces put the solid on the left.
  for (const key of directed) {
    const [a, b] = key.split('_').map(Number);
    if (directed.has(`${b}_${a}`)) continue;
    const va = vertices[a], vb = vertices[b];
    out.push(va.x, va.y, va.zBot, vb.x, vb.y, vb.zBot, vb.x, vb.y, vb.zTop);
    out.push(va.x, va.y, va.zBot, vb.x, vb.y, vb.zTop, va.x, va.y, va.zTop);
  }
}

/** Drop duplicate consecutive vertices and any closing vertex. */
function cleanRing(ring: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  ) {
    out.pop();
  }
  return out;
}

function signedArea(ring: THREE.Vector2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Merge triangle-soup geometries into one (e.g. road ribbons + aprons). */
export function mergeSoups(...geometries: Array<THREE.BufferGeometry | null>): THREE.BufferGeometry | null {
  const present = geometries.filter((g): g is THREE.BufferGeometry => g !== null);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  let total = 0;
  for (const g of present) total += g.getAttribute('position').count * 3;
  const positions = new Float32Array(total);
  let offset = 0;
  for (const g of present) {
    const arr = g.getAttribute('position').array as Float32Array;
    positions.set(arr, offset);
    offset += arr.length;
    g.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function toGeometry(positions: number[]): THREE.BufferGeometry | null {
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

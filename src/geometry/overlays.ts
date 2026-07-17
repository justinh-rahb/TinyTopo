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
 * painting them onto the terrain grid: polygons rasterize to a cell mask and
 * the overlay top reuses the terrain's own vertex heights (plus lift), so
 * the surface follows the relief exactly — no poke-through, no seams.
 * Features smaller than a couple of grid cells are draped as slabs instead
 * so pitches and ponds don't vanish in rasterization.
 */
export function buildPolygonOverlay(
  features: Feature<Polygon | MultiPolygon>[],
  bounds: Bounds,
  space: ModelSpace,
  dem: Dem,
  grid: TerrainGrid,
  style: SlabStyle,
): THREE.BufferGeometry | null {
  const { cols, rows, lons, lats } = grid;
  const cellsX = cols - 1;
  const cellsY = rows - 1;
  const mask = new Uint8Array(cellsX * cellsY);
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

      // Even-odd scanline fill across all rings (outer + holes). Edges are
      // quantized to the grid — at grid resolution finer than the print
      // nozzle, that's invisible on the printed part, and one uniform
      // strategy stays watertight with no seams between styles.
      const gridRings = [outer, ...holes].map((r) => r.map(([lon, lat]) => [gx(lon), gy(lat)]));
      const j0 = Math.max(0, Math.floor(yMin));
      const j1 = Math.min(cellsY - 1, Math.ceil(yMax));
      for (let j = j0; j <= j1; j++) {
        const yc = j + 0.5;
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
          const i0 = Math.max(0, Math.ceil(crossings[k] - 0.5));
          const i1 = Math.min(cellsX - 1, Math.floor(crossings[k + 1] - 0.5));
          for (let i = i0; i <= i1; i++) mask[j * cellsX + i] = 1;
        }
      }
    }
  }

  emitMask(positions, mask, grid, space, style);
  return toGeometry(positions);
}

/** Emit the masked cells as one watertight terrain-following layer. */
function emitMask(
  out: number[],
  mask: Uint8Array,
  grid: TerrainGrid,
  space: ModelSpace,
  style: SlabStyle,
): void {
  const { cols, rows, lons, lats, elev } = grid;
  const cellsX = cols - 1;
  const cellsY = rows - 1;
  const X = new Float32Array(cols);
  for (let i = 0; i < cols; i++) X[i] = space.x(lons[i]);
  const Y = new Float32Array(rows);
  for (let j = 0; j < rows; j++) Y[j] = space.y(lats[j]);
  const zTop = (i: number, j: number) => space.z(elev[j * cols + i]) + style.liftMm;
  const zBot = (i: number, j: number) => Math.max(0, zTop(i, j) - style.thicknessMm);
  const at = (i: number, j: number) => (j >= 0 && j < cellsY && i >= 0 && i < cellsX ? mask[j * cellsX + i] : 0);

  const wall = (ai: number, aj: number, bi: number, bj: number) => {
    // Walking a->b with the solid on the left gives outward normals.
    out.push(X[ai], Y[aj], zBot(ai, aj), X[bi], Y[bj], zBot(bi, bj), X[bi], Y[bj], zTop(bi, bj));
    out.push(X[ai], Y[aj], zBot(ai, aj), X[bi], Y[bj], zTop(bi, bj), X[ai], Y[aj], zTop(ai, aj));
  };

  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      if (!at(i, j)) continue;
      // Top (CCW from above) and mirrored bottom.
      out.push(X[i], Y[j], zTop(i, j), X[i + 1], Y[j], zTop(i + 1, j), X[i + 1], Y[j + 1], zTop(i + 1, j + 1));
      out.push(X[i], Y[j], zTop(i, j), X[i + 1], Y[j + 1], zTop(i + 1, j + 1), X[i], Y[j + 1], zTop(i, j + 1));
      out.push(X[i + 1], Y[j + 1], zBot(i + 1, j + 1), X[i + 1], Y[j], zBot(i + 1, j), X[i], Y[j], zBot(i, j));
      out.push(X[i], Y[j + 1], zBot(i, j + 1), X[i + 1], Y[j + 1], zBot(i + 1, j + 1), X[i], Y[j], zBot(i, j));

      if (!at(i, j - 1)) wall(i, j, i + 1, j); // south edge
      if (!at(i + 1, j)) wall(i + 1, j, i + 1, j + 1); // east edge
      if (!at(i, j + 1)) wall(i + 1, j + 1, i, j + 1); // north edge
      if (!at(i - 1, j)) wall(i, j + 1, i, j); // west edge
    }
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
 * Drape a polygon over relief by clipping it into grid cells, each draped as
 * its own small watertight slab (touching shells union in the slicer, same
 * as adjacent buildings). Large flat triangles no longer span hills — the
 * fix for "the green layer struggles on steep terrain".
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
      appendSlab(out, outerC, holesC, space, dem, style, 0.05);
    }
  }
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

/** Triangulate + drape a polygon (with holes) and give it slab thickness. */
function appendSlab(
  out: number[],
  outer: Position[],
  holes: Position[][],
  space: ModelSpace,
  dem: Dem,
  style: SlabStyle,
  minAreaMm2: number = MIN_AREA_MM2,
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
  const flat: Array<{ x: number; y: number; zTop: number; zBot: number }> = [];
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

  const tri = (a: number, b: number, c: number, top: boolean) => {
    const [va, vb, vc] = top ? [a, b, c] : [c, b, a];
    for (const i of [va, vb, vc]) {
      out.push(flat[i].x, flat[i].y, top ? flat[i].zTop : flat[i].zBot);
    }
  };

  const directed = new Set<string>();
  for (const [a, b, c] of faces) {
    tri(a, b, c, true);
    tri(a, b, c, false);
    directed.add(`${a}_${b}`).add(`${b}_${c}`).add(`${c}_${a}`);
  }

  // Walls on the triangulation's actual boundary (directed edges with no
  // reverse partner) — not on the input rings. Degenerate clipped rings can
  // make earcut drop triangles; walls that follow the emitted faces keep the
  // solid closed regardless. Top faces wind CCW, so a boundary edge a->b has
  // the interior on its left, giving outward wall normals.
  for (const key of directed) {
    const [a, b] = key.split('_').map(Number);
    if (directed.has(`${b}_${a}`)) continue;
    out.push(flat[a].x, flat[a].y, flat[a].zBot, flat[b].x, flat[b].y, flat[b].zBot, flat[b].x, flat[b].y, flat[b].zTop);
    out.push(flat[a].x, flat[a].y, flat[a].zBot, flat[b].x, flat[b].y, flat[b].zTop, flat[a].x, flat[a].y, flat[a].zTop);
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

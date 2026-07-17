import * as THREE from 'three';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { Bounds, ModelSpace } from '../geo';
import type { Dem } from '../elevation';
import { clipRing } from './clip';
import type { RoadLine } from '../overpass';

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

/** Build one geometry from polygonal features (water, green). */
export function buildPolygonOverlay(
  features: Feature<Polygon | MultiPolygon>[],
  bounds: Bounds,
  space: ModelSpace,
  dem: Dem,
  style: SlabStyle,
): THREE.BufferGeometry | null {
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
      appendSlabCelled(positions, outer, holes, space, dem, style);
    }
  }
  return toGeometry(positions);
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

  for (const [a, b, c] of faces) {
    tri(a, b, c, true);
    tri(a, b, c, false);
  }

  // Walls: ring direction (outer CCW, holes CW) makes this winding outward.
  let offset = 0;
  for (const ring of allRings) {
    for (let i = 0; i < ring.length; i++) {
      const a = offset + i;
      const b = offset + ((i + 1) % ring.length);
      out.push(flat[a].x, flat[a].y, flat[a].zBot, flat[b].x, flat[b].y, flat[b].zBot, flat[b].x, flat[b].y, flat[b].zTop);
      out.push(flat[a].x, flat[a].y, flat[a].zBot, flat[b].x, flat[b].y, flat[b].zTop, flat[a].x, flat[a].y, flat[a].zTop);
    }
    offset += ring.length;
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

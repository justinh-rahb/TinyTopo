import * as THREE from 'three';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { Bounds, ModelSpace } from '../geo';
import type { Dem } from '../elevation';
import { clipRing } from './clip';

const DEFAULT_HEIGHT_M = 8;
const METERS_PER_LEVEL = 3;
const MAX_HEIGHT_M = 500;
/** How far buildings sink below the terrain surface, in mm, to guarantee overlap. */
const EMBED_MM = 1;
/** Clipped footprints smaller than this print as fragile needles — skip them. */
const MIN_FOOTPRINT_MM2 = 0.5;

/** Extrude building footprints into printable solids seated on the terrain. */
export function buildBuildings(
  features: Feature<Polygon | MultiPolygon>[],
  bounds: Bounds,
  space: ModelSpace,
  dem: Dem,
): THREE.BufferGeometry | null {
  const positions: number[] = [];

  for (const feature of features) {
    const polygons: Position[][][] =
      feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const heightM = buildingHeightMeters(props);
    // building:part semantics: the solid spans min_height..height above ground.
    const minHeightM = Math.min(parseLengthM(props['min_height']) ?? 0, heightM);

    for (const rings of polygons) {
      const outer = clipRing(rings[0] ?? [], bounds);
      if (outer.length < 3) continue;

      const points = outer.map(([lon, lat]) => new THREE.Vector2(space.x(lon), space.y(lat)));
      if (Math.abs(polygonAreaMm2(points)) < MIN_FOOTPRINT_MM2) continue;

      // Seat the solid against the terrain under the (clipped) footprint.
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [lon, lat] of outer) {
        const z = space.z(dem.sample(lon, lat));
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const scaleZ = space.mmPerMeter * space.zFactor;
      const bottom = minHeightM > 0 ? maxZ + minHeightM * scaleZ : Math.max(0, minZ - EMBED_MM);
      const top = maxZ + heightM * scaleZ;
      if (top - bottom < 0.05) continue;

      const shape = new THREE.Shape(points);
      for (const hole of rings.slice(1)) {
        const clipped = clipRing(hole, bounds);
        if (clipped.length >= 3) {
          shape.holes.push(
            new THREE.Path(clipped.map(([lon, lat]) => new THREE.Vector2(space.x(lon), space.y(lat)))),
          );
        }
      }

      const extruded = new THREE.ExtrudeGeometry(shape, {
        depth: top - bottom,
        bevelEnabled: false,
      }).translate(0, 0, bottom);
      appendPositions(positions, extruded);
      extruded.dispose();
    }
  }

  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function buildingHeightMeters(props: Record<string, unknown>): number {
  const explicit = parseLengthM(props['height'] ?? props['building:height']);
  if (explicit !== null && explicit > 0) return Math.min(explicit, MAX_HEIGHT_M);
  const levels = parseFloat(String(props['building:levels'] ?? ''));
  if (Number.isFinite(levels) && levels > 0) return Math.min(levels * METERS_PER_LEVEL, MAX_HEIGHT_M);
  return DEFAULT_HEIGHT_M;
}

/**
 * Parse an OSM length tag to meters. Handles bare numbers (meters), comma
 * decimals, explicit "m", and feet ("25 ft", "25'"). Anything else -> null.
 */
function parseLengthM(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase().replace(',', '.');
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|')?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
}

function polygonAreaMm2(ring: THREE.Vector2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function appendPositions(out: number[], geometry: THREE.BufferGeometry): void {
  const soup = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = soup.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  if (soup !== geometry) soup.dispose();
}

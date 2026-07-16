import * as THREE from 'three';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { Bounds, ModelSpace } from '../geo';
import type { Dem } from '../elevation';
import { clipRing } from './clip';

const DEFAULT_HEIGHT_M = 8;
const METERS_PER_LEVEL = 3;
/** How far buildings sink below the terrain surface, in mm, to guarantee overlap. */
const EMBED_MM = 1;

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
    const heightM = buildingHeightMeters(feature.properties ?? {});

    for (const rings of polygons) {
      const outer = clipRing(rings[0] ?? [], bounds);
      if (outer.length < 3) continue;

      // Seat the solid against the terrain under the (clipped) footprint.
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [lon, lat] of outer) {
        const z = space.z(dem.sample(lon, lat));
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const bottom = Math.max(0, minZ - EMBED_MM);
      const top = maxZ + heightM * space.mmPerMeter * space.zFactor;

      const shape = new THREE.Shape(outer.map(([lon, lat]) => new THREE.Vector2(space.x(lon), space.y(lat))));
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
  const explicit = parseFloat(String(props['height'] ?? props['building:height'] ?? ''));
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, 500);
  const levels = parseFloat(String(props['building:levels'] ?? ''));
  if (Number.isFinite(levels) && levels > 0) return Math.min(levels * METERS_PER_LEVEL, 500);
  return DEFAULT_HEIGHT_M;
}

function appendPositions(out: number[], geometry: THREE.BufferGeometry): void {
  const soup = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = soup.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  if (soup !== geometry) soup.dispose();
}

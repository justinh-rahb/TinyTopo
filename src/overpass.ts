import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Polygon, Position } from 'geojson';
import { Bounds } from './geo';

/** Public Overpass instances, tried in order. All request fair use. */
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export interface RoadLine {
  points: Position[];
  widthM: number;
}

export interface MapFeatures {
  buildings: Feature<Polygon | MultiPolygon>[];
  roads: RoadLine[];
  /** Paved airport areas (aprons) — rendered with the roads layer. */
  aprons: Feature<Polygon | MultiPolygon>[];
  water: Feature<Polygon | MultiPolygon>[];
  green: Feature<Polygon | MultiPolygon>[];
}

/** Printed road width in meters by highway class. Unlisted classes are skipped. */
const ROAD_WIDTHS: Record<string, number> = {
  motorway: 18,
  motorway_link: 9,
  trunk: 16,
  trunk_link: 9,
  primary: 13,
  primary_link: 9,
  secondary: 11,
  secondary_link: 8,
  tertiary: 9,
  tertiary_link: 7,
  residential: 7,
  unclassified: 7,
  living_street: 6,
  service: 5,
  pedestrian: 5,
  busway: 7,
  road: 7,
  track: 4,
  cycleway: 2.5,
  footway: 2,
  path: 2,
};

const RAIL_VALUES = new Set(['rail', 'light_rail', 'tram']);
const RAIL_WIDTH_M = 4;

/** Printed width in meters for aeroway centerlines. */
const AEROWAY_WIDTHS: Record<string, number> = {
  runway: 45,
  taxiway: 18,
};

const GREEN_VALUES = new Set([
  'park', 'garden', 'golf_course', 'pitch', 'playground', 'village_green',
  'grass', 'meadow', 'forest', 'orchard', 'vineyard', 'cemetery',
  'recreation_ground', 'allotments', 'wood', 'scrub', 'grassland', 'heath',
]);

const GREEN_REGEX = [...GREEN_VALUES].join('|');

/**
 * Fetch buildings, roads/rails, water, and green areas intersecting the
 * bounds from the public Overpass API, classified for the geometry pipeline.
 */
export async function fetchMapFeatures(bounds: Bounds): Promise<MapFeatures> {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const query = `
[out:json][timeout:25];
(
  way["building"](${bbox});
  relation["building"]["type"="multipolygon"](${bbox});
  way["building:part"](${bbox});
  relation["building:part"]["type"="multipolygon"](${bbox});
  way["highway"](${bbox});
  way["railway"~"^(rail|light_rail|tram)$"](${bbox});
  way["aeroway"~"^(runway|taxiway|apron)$"](${bbox});
  relation["aeroway"="apron"]["type"="multipolygon"](${bbox});
  way["natural"="water"](${bbox});
  relation["natural"="water"]["type"="multipolygon"](${bbox});
  way["waterway"="riverbank"](${bbox});
  way["natural"="coastline"](${bbox});
  way[~"^(leisure|landuse|natural)$"~"^(${GREEN_REGEX})$"](${bbox});
  relation[~"^(leisure|landuse|natural)$"~"^(${GREEN_REGEX})$"]["type"="multipolygon"](${bbox});
);
out body;
>;
out skel qt;`;

  let lastError: Error | null = null;
  let data: unknown = null;
  for (const url of OVERPASS_URLS) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        body: query,
        signal: AbortSignal.timeout(45_000),
      });
      if (!resp.ok) throw new Error(`Overpass request failed: ${resp.status} ${resp.statusText}`);
      const json = (await resp.json()) as { remark?: string };
      // Overloaded instances return HTTP 200 with a remark and no data —
      // treat that as a failure so we fail over instead of silently
      // rendering a bald model.
      if (json.remark && /error|timed?[ _-]?out/i.test(json.remark)) {
        throw new Error(`Overpass: ${json.remark}`);
      }
      data = json;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Overpass instance ${url} failed, trying next`, err);
    }
  }
  if (data === null) {
    if (lastError?.name === 'TimeoutError' || lastError?.message.includes('timed out')) {
      throw new Error('OpenStreetMap servers are busy — try again in a minute or select a smaller area.');
    }
    throw lastError ?? new Error('All Overpass instances failed');
  }

  const collection = osmtogeojson(data) as FeatureCollection;
  const result: MapFeatures = { buildings: [], roads: [], aprons: [], water: [], green: [] };
  const coastlines: Position[][] = [];

  for (const f of collection.features) {
    const p = (f.properties ?? {}) as Record<string, string>;
    const isPolygonal = f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';

    // Prefer the mapper-surveyed width tag over class defaults, within reason.
    const taggedWidth = (() => {
      const w = parseFloat(String(p['width'] ?? ''));
      return Number.isFinite(w) && w > 0 ? Math.min(Math.max(w, 2), 80) : null;
    })();
    const line = (defaultWidth: number) =>
      result.roads.push({
        points: (f.geometry as LineString).coordinates,
        widthM: taggedWidth ?? defaultWidth,
      });

    if (p['natural'] === 'coastline' && f.geometry.type === 'LineString') {
      coastlines.push(f.geometry.coordinates);
    } else if (p['natural'] === 'coastline' && f.geometry.type === 'MultiLineString') {
      coastlines.push(...(f.geometry as MultiLineString).coordinates);
    } else if (isPolygonal && (p['building'] || p['building:part'])) {
      result.buildings.push(f as Feature<Polygon | MultiPolygon>);
    } else if (f.geometry.type === 'LineString' && p['highway'] && ROAD_WIDTHS[p['highway']]) {
      line(ROAD_WIDTHS[p['highway']]);
    } else if (f.geometry.type === 'LineString' && RAIL_VALUES.has(p['railway'])) {
      line(RAIL_WIDTH_M);
    } else if (f.geometry.type === 'LineString' && AEROWAY_WIDTHS[p['aeroway']]) {
      // Width tags on runways are sometimes junk (e.g. 10m on a main
      // runway) — never let a tag shrink an aeroway below ~2/3 of its
      // class default.
      const base = AEROWAY_WIDTHS[p['aeroway']];
      result.roads.push({
        points: (f.geometry as LineString).coordinates,
        widthM: Math.max(taggedWidth ?? base, base * 0.66),
      });
    } else if (isPolygonal && p['aeroway'] === 'apron') {
      result.aprons.push(f as Feature<Polygon | MultiPolygon>);
    } else if (isPolygonal && (p['natural'] === 'water' || p['waterway'] === 'riverbank' || p['water'])) {
      result.water.push(f as Feature<Polygon | MultiPolygon>);
    } else if (
      isPolygonal &&
      (GREEN_VALUES.has(p['leisure']) || GREEN_VALUES.has(p['landuse']) || GREEN_VALUES.has(p['natural']))
    ) {
      result.green.push(f as Feature<Polygon | MultiPolygon>);
    }
  }
  result.water.push(...coastlineWaterFeatures(coastlines, bounds));
  return result;
}

/** Convert directed OSM coastlines (land left, sea right) into clipped ocean polygons. */
export function coastlineWaterFeatures(lines: Position[][], bounds: Bounds): Feature<Polygon>[] {
  const polygons: Position[][] = [];
  const islands: Position[][] = [];

  for (const line of stitchDirectedLines(lines)) {
    if (line.length < 2) continue;
    if (samePosition(line[0], line[line.length - 1])) {
      islands.push(closeRing(line));
      continue;
    }

    for (const clipped of clipLine(line, bounds)) {
      if (clipped.length < 2) continue;
      const start = clipped[0];
      const end = clipped[clipped.length - 1];
      if (!onBoundary(start, bounds) || !onBoundary(end, bounds)) continue;

      const ccw = boundaryPathCcw(end, start, bounds);
      const cw = [...boundaryPathCcw(start, end, bounds)].reverse();
      const ccwRing = closeRing([...clipped, ...ccw.slice(1)]);
      const cwRing = closeRing([...clipped, ...cw.slice(1)]);
      // Following the coastline forward, ocean lies on the right: the ocean
      // ring is therefore clockwise in lon/lat model space.
      polygons.push(signedRingArea(ccwRing) < 0 ? ccwRing : cwRing);
    }
  }

  if (polygons.length === 0 && islands.length > 0) {
    polygons.push(closeRing([
      [bounds.west, bounds.south],
      [bounds.east, bounds.south],
      [bounds.east, bounds.north],
      [bounds.west, bounds.north],
    ]));
  }

  return polygons.map((outer) => ({
    type: 'Feature',
    properties: { natural: 'water', source: 'coastline' },
    geometry: {
      type: 'Polygon',
      coordinates: [outer, ...islands.filter((ring) => pointInRing(ring[0], outer))],
    },
  }));
}

/** Join adjacent coastline ways without reversing their semantic direction. */
function stitchDirectedLines(lines: Position[][]): Position[][] {
  const chains = lines.filter((line) => line.length >= 2).map((line) => [...line]);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const a = chains[i], b = chains[j];
        if (samePosition(a[a.length - 1], b[0])) {
          chains[i] = [...a, ...b.slice(1)];
        } else if (samePosition(b[b.length - 1], a[0])) {
          chains[i] = [...b, ...a.slice(1)];
        } else {
          continue;
        }
        chains.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return chains;
}

/** Liang-Barsky clip of a polyline, preserving each in-bounds run. */
function clipLine(line: Position[], bounds: Bounds): Position[][] {
  const pieces: Position[][] = [];
  let current: Position[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const segment = clipSegment(line[i], line[i + 1], bounds);
    if (!segment) {
      if (current.length >= 2) pieces.push(current);
      current = [];
      continue;
    }
    const [a, b] = segment;
    if (current.length > 0 && samePosition(current[current.length - 1], a)) current.push(b);
    else {
      if (current.length >= 2) pieces.push(current);
      current = [a, b];
    }
    if (!insideBounds(line[i + 1], bounds)) {
      pieces.push(current);
      current = [];
    }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

function clipSegment(a: Position, b: Position, bounds: Bounds): [Position, Position] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - bounds.west, bounds.east - a[0], a[1] - bounds.south, bounds.north - a[1]];
  let lo = 0, hi = 1;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-15) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return [
    [a[0] + dx * lo, a[1] + dy * lo],
    [a[0] + dx * hi, a[1] + dy * hi],
  ];
}

/** Walk counter-clockwise around the selection boundary from `from` to `to`. */
function boundaryPathCcw(from: Position, to: Position, bounds: Bounds): Position[] {
  const w = bounds.east - bounds.west;
  const h = bounds.north - bounds.south;
  const perimeter = 2 * (w + h);
  const corners: Array<[number, Position]> = [
    [w, [bounds.east, bounds.south]],
    [w + h, [bounds.east, bounds.north]],
    [2 * w + h, [bounds.west, bounds.north]],
    [perimeter, [bounds.west, bounds.south]],
  ];
  const startT = boundaryOffset(from, bounds);
  let endT = boundaryOffset(to, bounds);
  if (endT <= startT) endT += perimeter;
  const path: Position[] = [from];
  for (const [baseT, corner] of corners) {
    let t = baseT;
    while (t <= startT) t += perimeter;
    if (t < endT) path.push(corner);
  }
  path.push(to);
  return path;
}

function boundaryOffset(p: Position, bounds: Bounds): number {
  const w = bounds.east - bounds.west;
  const h = bounds.north - bounds.south;
  const eps = Math.max(w, h) * 1e-9 + 1e-12;
  if (Math.abs(p[1] - bounds.south) <= eps) return p[0] - bounds.west;
  if (Math.abs(p[0] - bounds.east) <= eps) return w + p[1] - bounds.south;
  if (Math.abs(p[1] - bounds.north) <= eps) return 2 * w + h - p[0] + bounds.west;
  return 2 * w + 2 * h - p[1] + bounds.south;
}

function onBoundary(p: Position, bounds: Bounds): boolean {
  const eps = Math.max(bounds.east - bounds.west, bounds.north - bounds.south) * 1e-9 + 1e-12;
  return (
    Math.abs(p[0] - bounds.west) <= eps || Math.abs(p[0] - bounds.east) <= eps ||
    Math.abs(p[1] - bounds.south) <= eps || Math.abs(p[1] - bounds.north) <= eps
  );
}

function insideBounds(p: Position, bounds: Bounds): boolean {
  return p[0] >= bounds.west && p[0] <= bounds.east && p[1] >= bounds.south && p[1] <= bounds.north;
}

function closeRing(ring: Position[]): Position[] {
  return samePosition(ring[0], ring[ring.length - 1]) ? ring : [...ring, ring[0]];
}

function samePosition(a: Position, b: Position): boolean {
  return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
}

function signedRingArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0; i + 1 < ring.length; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return area / 2;
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

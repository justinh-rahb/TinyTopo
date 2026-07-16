import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon, Position } from 'geojson';
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
  way["highway"](${bbox});
  way["railway"~"^(rail|light_rail|tram)$"](${bbox});
  way["natural"="water"](${bbox});
  relation["natural"="water"]["type"="multipolygon"](${bbox});
  way["waterway"="riverbank"](${bbox});
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
      data = await resp.json();
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
  const result: MapFeatures = { buildings: [], roads: [], water: [], green: [] };

  for (const f of collection.features) {
    const p = (f.properties ?? {}) as Record<string, string>;
    const isPolygonal = f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';

    if (isPolygonal && (p['building'] || p['building:part'])) {
      result.buildings.push(f as Feature<Polygon | MultiPolygon>);
    } else if (f.geometry.type === 'LineString' && p['highway'] && ROAD_WIDTHS[p['highway']]) {
      result.roads.push({ points: (f.geometry as LineString).coordinates, widthM: ROAD_WIDTHS[p['highway']] });
    } else if (f.geometry.type === 'LineString' && RAIL_VALUES.has(p['railway'])) {
      result.roads.push({ points: (f.geometry as LineString).coordinates, widthM: RAIL_WIDTH_M });
    } else if (isPolygonal && (p['natural'] === 'water' || p['waterway'] === 'riverbank' || p['water'])) {
      result.water.push(f as Feature<Polygon | MultiPolygon>);
    } else if (
      isPolygonal &&
      (GREEN_VALUES.has(p['leisure']) || GREEN_VALUES.has(p['landuse']) || GREEN_VALUES.has(p['natural']))
    ) {
      result.green.push(f as Feature<Polygon | MultiPolygon>);
    }
  }
  return result;
}

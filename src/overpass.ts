import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { Bounds } from './geo';

/** Public Overpass instances, tried in order. All request fair use. */
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Fetch building footprints intersecting the bounds from the public Overpass
 * API. Returns polygonal features only, with OSM tags as properties.
 */
export async function fetchBuildings(
  bounds: Bounds,
): Promise<Feature<Polygon | MultiPolygon>[]> {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const query = `
[out:json][timeout:25];
(
  way["building"](${bbox});
  relation["building"]["type"="multipolygon"](${bbox});
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
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`Overpass request failed: ${resp.status} ${resp.statusText}`);
      data = await resp.json();
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Overpass instance ${url} failed, trying next`, err);
    }
  }
  if (data === null) throw lastError ?? new Error('All Overpass instances failed');

  const collection = osmtogeojson(data) as FeatureCollection;
  return collection.features.filter(
    (f): f is Feature<Polygon | MultiPolygon> =>
      f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon',
  );
}

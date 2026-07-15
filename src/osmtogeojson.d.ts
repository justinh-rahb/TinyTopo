declare module 'osmtogeojson' {
  import type { FeatureCollection } from 'geojson';
  export default function osmtogeojson(
    data: unknown,
    options?: Record<string, unknown>,
  ): FeatureCollection;
}

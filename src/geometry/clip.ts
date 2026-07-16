import type { Position } from 'geojson';
import { Bounds } from '../geo';

/** Sutherland–Hodgman clip of a ring against the selection rectangle. */
export function clipRing(ring: Position[], b: Bounds): Position[] {
  // Drop the GeoJSON closing vertex; we work with open rings.
  let pts = ring.slice(0, ring.length > 1 && isSame(ring[0], ring[ring.length - 1]) ? -1 : undefined);
  const edges: Array<(p: Position) => boolean> = [
    (p) => p[0] >= b.west,
    (p) => p[0] <= b.east,
    (p) => p[1] >= b.south,
    (p) => p[1] <= b.north,
  ];
  const intersect: Array<(a: Position, c: Position) => Position> = [
    (a, c) => atLon(a, c, b.west),
    (a, c) => atLon(a, c, b.east),
    (a, c) => atLat(a, c, b.south),
    (a, c) => atLat(a, c, b.north),
  ];

  for (let e = 0; e < 4 && pts.length > 0; e++) {
    const inside = edges[e];
    const cross = intersect[e];
    const out: Position[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(cross(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(cross(prev, cur));
      }
    }
    pts = out;
  }
  return pts;
}

function atLon(a: Position, c: Position, lon: number): Position {
  const t = (lon - a[0]) / (c[0] - a[0]);
  return [lon, a[1] + (c[1] - a[1]) * t];
}

function atLat(a: Position, c: Position, lat: number): Position {
  const t = (lat - a[1]) / (c[1] - a[1]);
  return [a[0] + (c[0] - a[0]) * t, lat];
}

function isSame(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

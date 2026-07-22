import * as THREE from 'three';
import type { Feature, Polygon, Position } from 'geojson';
import { Bounds, ModelSpace } from '../geo';
import type { Dem } from '../elevation';
import type { TerrainGrid } from './terrain';
import { buildPolygonOverlay } from './overlays';

export interface PuzzlePiece {
  row: number;
  col: number;
  geometry: THREE.BufferGeometry;
}

export interface PuzzleLayout {
  cols: number;
  rows: number;
  /** Piece footprint before the tab profile is applied to interior edges. */
  pieceWidthMm: number;
  pieceHeightMm: number;
}

const MIN_PIECE_MM = 20;
/** Gap left between assembled pieces, in mm (print/assembly tolerance). */
const CLEARANCE_MM = 0.15;
/** Interior-tab depth as a fraction of the smaller piece dimension. */
const TAB_FRACTION = 0.22;
const TAB_MIN_MM = 2.5;
const TAB_MAX_MM = 10;

/**
 * Given a requested column/row count, shrink it until every piece is at
 * least MIN_PIECE_MM on both axes — small pieces have no room for a tab.
 */
export function fitPuzzleGrid(widthMm: number, depthMm: number, cols: number, rows: number): PuzzleLayout {
  let c = Math.max(1, Math.round(cols));
  let r = Math.max(1, Math.round(rows));
  while (c > 1 && widthMm / c < MIN_PIECE_MM) c--;
  while (r > 1 && depthMm / r < MIN_PIECE_MM) r--;
  return { cols: c, rows: r, pieceWidthMm: widthMm / c, pieceHeightMm: depthMm / r };
}

/** Deterministic 32-bit PRNG (mulberry32), seeded from the selection. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashBounds(bounds: Bounds): number {
  const s = `${bounds.west.toFixed(6)}|${bounds.south.toFixed(6)}|${bounds.east.toFixed(6)}|${bounds.north.toFixed(6)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Unit "flask" tab profile: dx/amp, dy/amp offsets along an edge, centered
 * at the edge midpoint. dy is signed depth into the neighbor; the sequence
 * deliberately backtracks in dx partway through (see the -0.42 → -0.49 →
 * -0.33 run) so the boundary has a true reentrant neck rather than a smooth
 * bump — the shape a physical puzzle piece actually needs to read as
 * "interlocking" rather than just wavy.
 */
const TAB_TEMPLATE: Array<[number, number]> = [
  [-0.711, 0.0],
  [-0.667, 0.267],
  [-0.422, 0.333],
  [-0.489, 0.667],
  [-0.333, 0.911],
  [0.0, 1.0],
  [0.333, 0.911],
  [0.489, 0.667],
  [0.422, 0.333],
  [0.667, 0.267],
  [0.711, 0.0],
];

/** Build a wiggled interior-edge curve from `a` to `b` (mm), or a straight run if `sign` is 0 (border). */
function edgeCurve(a: [number, number], b: [number, number], sign: number, jitter: number, tabAmpMm: number): Position[] {
  if (sign === 0) return [a, b];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const dirX = dx / len;
  const dirY = dy / len;
  const perpX = -dirY * sign;
  const perpY = dirX * sign;
  const midX = (a[0] + b[0]) / 2;
  const midY = (a[1] + b[1]) / 2;
  const amp = Math.min(tabAmpMm, len * 0.14) * jitter;

  const pts: Position[] = [a];
  for (const [t, d] of TAB_TEMPLATE) {
    pts.push([midX + dirX * t * amp + perpX * d * amp, midY + dirY * t * amp + perpY * d * amp]);
  }
  pts.push(b);
  return pts;
}

/** Move every vertex of a CCW ring inward along its local bisector normal. */
function shrinkRing(ring: Position[], amountMm: number): Position[] {
  const n = ring.length;
  return ring.map((p, i) => {
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    const e1x = p[0] - prev[0], e1y = p[1] - prev[1];
    const e2x = next[0] - p[0], e2y = next[1] - p[1];
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    // Left-hand normals of a CCW ring point inward.
    const n1x = -e1y / l1, n1y = e1x / l1;
    const n2x = -e2y / l2, n2y = e2x / l2;
    let bx = n1x + n2x, by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) {
      bx = n1x;
      by = n1y;
    } else {
      bx /= bl;
      by /= bl;
    }
    return [p[0] + bx * amountMm, p[1] + by * amountMm] as Position;
  });
}

function dedupe(ring: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) out.push(p);
  }
  return out;
}

/**
 * Cut the terrain+base into interlocking jigsaw pieces. Each piece is its
 * own watertight solid (top follows real relief, bottom flat to the bed) —
 * built by feeding a synthetic piece boundary through the same terrain-grid
 * overlay pipeline already used for water/greenery/roads, so it inherits
 * that code's marching-squares smoothing and directed-edge wall hardening
 * for free. Replaces the Base + Terrain bodies; map-detail layers aren't
 * cut into pieces yet.
 */
export function buildPuzzlePieces(
  bounds: Bounds,
  space: ModelSpace,
  dem: Dem,
  grid: TerrainGrid,
  layout: PuzzleLayout,
): PuzzlePiece[] {
  const { cols, rows, pieceWidthMm: pw, pieceHeightMm: ph } = layout;
  const rng = mulberry32(hashBounds(bounds));
  const tabAmpV = THREE.MathUtils.clamp(Math.min(pw, ph) * TAB_FRACTION, TAB_MIN_MM, TAB_MAX_MM);
  const tabAmpH = tabAmpV;
  const x0 = -space.widthMm / 2;
  const y0 = -space.depthMm / 2;
  const corner = (c: number, r: number): [number, number] => [x0 + c * pw, y0 + r * ph];

  // Canonical curves, generated once per interior edge and shared by both
  // adjacent pieces (forward for one side, reversed for the other) so
  // boundaries tile exactly with no gap or overlap before the clearance
  // shrink is applied per piece.
  const vCurve: Position[][][] = []; // vCurve[row][col] = edge between col c and c+1, bottom->top
  for (let r = 0; r < rows; r++) {
    vCurve.push([]);
    for (let c = 0; c < cols - 1; c++) {
      const sign = rng() < 0.5 ? -1 : 1;
      const jitter = 0.85 + rng() * 0.3;
      vCurve[r].push(edgeCurve(corner(c + 1, r), corner(c + 1, r + 1), sign, jitter, tabAmpV));
    }
  }
  const hCurve: Position[][][] = []; // hCurve[row][col] = edge between row r and r+1, left->right
  for (let r = 0; r < rows - 1; r++) {
    hCurve.push([]);
    for (let c = 0; c < cols; c++) {
      const sign = rng() < 0.5 ? -1 : 1;
      const jitter = 0.85 + rng() * 0.3;
      hCurve[r].push(edgeCurve(corner(c, r + 1), corner(c + 1, r + 1), sign, jitter, tabAmpH));
    }
  }

  const pieces: PuzzlePiece[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bottom = r === 0 ? [corner(c, r), corner(c + 1, r)] : hCurve[r - 1][c];
      const right = c === cols - 1 ? [corner(c + 1, r), corner(c + 1, r + 1)] : vCurve[r][c];
      const top = r === rows - 1 ? [corner(c + 1, r + 1), corner(c, r + 1)] : [...hCurve[r][c]].reverse();
      const left = c === 0 ? [corner(c, r + 1), corner(c, r)] : [...vCurve[r][c - 1]].reverse();

      let ring = dedupe([...bottom, ...right, ...top, ...left]);
      ring = shrinkRing(ring, CLEARANCE_MM / 2);

      const feature: Feature<Polygon> = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [ring.map(([x, y]) => [space.lon(x), space.lat(y)] as Position)],
        },
      };

      const result = buildPolygonOverlay([feature], bounds, space, dem, grid, { liftMm: 0, thicknessMm: 1e6 });
      if (result.geometry) pieces.push({ row: r, col: c, geometry: result.geometry });
    }
  }
  return pieces;
}

import { Bounds, lonToTileX, latToTileY } from './geo';

/** A sampled digital elevation model covering a bounds. */
export interface Dem {
  /** Elevation in meters at a WGS84 coordinate (bilinear). */
  sample(lon: number, lat: number): number;
  source: string;
}

interface TerrainSource {
  name: string;
  url(z: number, x: number, y: number): string;
  tileSize: number;
  maxZoom: number;
}

/**
 * Terrarium-encoded terrain tiles. Both sources are open data; AWS Terrain
 * Tiles (Mapzen) is primary, Mapterhorn the fallback. Same encoding:
 * elevation = (R * 256 + G + B / 256) - 32768.
 */
const SOURCES: TerrainSource[] = [
  {
    name: 'Terrain Tiles (Mapzen/AWS)',
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    tileSize: 256,
    maxZoom: 15,
  },
  {
    name: 'Mapterhorn',
    url: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`,
    tileSize: 512,
    maxZoom: 12,
  },
];

const TARGET_PX = 480;
const MAX_TILES = 32;

async function loadFromSource(src: TerrainSource, bounds: Bounds): Promise<Dem> {
  // Pick a zoom where the selection spans roughly TARGET_PX pixels.
  const idealZ = Math.log2((TARGET_PX * 360) / ((bounds.east - bounds.west) * src.tileSize));
  let z = Math.min(src.maxZoom, Math.max(1, Math.ceil(idealZ)));

  let tx0 = 0, tx1 = 0, ty0 = 0, ty1 = 0;
  for (; z >= 1; z--) {
    tx0 = Math.floor(lonToTileX(bounds.west, z));
    tx1 = Math.floor(lonToTileX(bounds.east, z));
    ty0 = Math.floor(latToTileY(bounds.north, z));
    ty1 = Math.floor(latToTileY(bounds.south, z));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_TILES) break;
  }
  if (z < 1) throw new Error('Selection too large for elevation source');

  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const ts = src.tileSize;
  const canvas = document.createElement('canvas');
  canvas.width = cols * ts;
  canvas.height = rows * ts;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D unavailable');

  await Promise.all(
    Array.from({ length: cols * rows }, async (_, i) => {
      const dx = i % cols;
      const dy = Math.floor(i / cols);
      const resp = await fetch(src.url(z, tx0 + dx, ty0 + dy));
      if (!resp.ok) throw new Error(`${src.name}: tile fetch failed (${resp.status})`);
      const bitmap = await createImageBitmap(await resp.blob());
      ctx.drawImage(bitmap, dx * ts, dy * ts);
      bitmap.close();
    }),
  );

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const elev = new Float32Array(width * height);
  for (let i = 0; i < elev.length; i++) {
    const o = i * 4;
    elev[i] = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
  }

  const zoom = z;
  const sample = (lon: number, lat: number): number => {
    const px = (lonToTileX(lon, zoom) - tx0) * ts;
    const py = (latToTileY(lat, zoom) - ty0) * ts;
    const x = Math.min(Math.max(px, 0), width - 1.001);
    const y = Math.min(Math.max(py, 0), height - 1.001);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (xx: number, yy: number) => elev[yy * width + xx];
    return (
      at(x0, y0) * (1 - fx) * (1 - fy) +
      at(x0 + 1, y0) * fx * (1 - fy) +
      at(x0, y0 + 1) * (1 - fx) * fy +
      at(x0 + 1, y0 + 1) * fx * fy
    );
  };

  return { sample, source: src.name };
}

export async function loadDem(bounds: Bounds): Promise<Dem> {
  let lastError: unknown;
  for (const src of SOURCES) {
    try {
      return await loadFromSource(src, bounds);
    } catch (err) {
      lastError = err;
      console.warn(`Elevation source ${src.name} failed, trying next`, err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All elevation sources failed');
}

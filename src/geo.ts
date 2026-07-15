/** Geographic bounds in WGS84 degrees. */
export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQUATOR = 111320;

export function centerOf(b: Bounds): { lat: number; lon: number } {
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

export function metersPerDegLon(lat: number): number {
  return M_PER_DEG_LON_EQUATOR * Math.cos((lat * Math.PI) / 180);
}

export function widthMeters(b: Bounds): number {
  return (b.east - b.west) * metersPerDegLon(centerOf(b).lat);
}

export function heightMeters(b: Bounds): number {
  return (b.north - b.south) * M_PER_DEG_LAT;
}

/**
 * Model space: maps WGS84 coordinates into millimeters on the print bed.
 * X grows east, Y grows north, Z grows up; origin at the selection center
 * with Z=0 at the bottom of the base plinth.
 */
export class ModelSpace {
  readonly widthMm: number;
  readonly depthMm: number;
  readonly mmPerMeter: number;
  private readonly lat0: number;
  private readonly lon0: number;
  private readonly mPerDegLon: number;

  constructor(
    readonly bounds: Bounds,
    widthMm: number,
    readonly zFactor: number,
    readonly baseMm: number,
    readonly minElevation: number,
  ) {
    const c = centerOf(bounds);
    this.lat0 = c.lat;
    this.lon0 = c.lon;
    this.mPerDegLon = metersPerDegLon(c.lat);
    const wM = widthMeters(bounds);
    this.mmPerMeter = widthMm / wM;
    this.widthMm = widthMm;
    this.depthMm = heightMeters(bounds) * this.mmPerMeter;
  }

  x(lon: number): number {
    return (lon - this.lon0) * this.mPerDegLon * this.mmPerMeter;
  }

  y(lat: number): number {
    return (lat - this.lat0) * M_PER_DEG_LAT * this.mmPerMeter;
  }

  /** Elevation in meters above sea level -> model Z in mm. */
  z(elevationM: number): number {
    return this.baseMm + (elevationM - this.minElevation) * this.mmPerMeter * this.zFactor;
  }
}

/** Web-mercator slippy tile helpers. */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

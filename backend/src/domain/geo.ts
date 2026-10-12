/**
 * Geospatial rules.
 *
 * These constants and helpers are the server-side counterparts of
 * `src/lib/geo.ts` in the mobile app. The *application* values must stay in sync
 * (radius bounds, write throttle); the database is the authority, and this
 * module is what the SQL is built from - a single place to read the numbers.
 */

/** Default nearby search radius. */
export const DEFAULT_RADIUS_METERS = 5000;
export const MIN_RADIUS_METERS = 1000;
export const MAX_RADIUS_METERS = 10000;

/**
 * A stored fix does not expire.
 *
 * Every earlier phase ignored a fix older than 24 hours. A nearby area is now
 * kept until its owner changes it, switches nearby discovery off or closes the
 * account, so no discovery query filters on `location_updated_at` any more: the
 * member is found from exactly the area they last chose, however long ago that
 * was. The column is still written on every save (and read by
 * `locationService` and the profile row) purely so the app can say *when* the
 * area was last set - "Update nearby area" is a decision the member makes, not
 * a clock the server runs.
 */

/** Coordinates are rounded to ~11 m before storage. */
export const COORDINATE_PRECISION_DECIMALS = 4;

/** A second write inside this window keeps the existing timestamp. */
export const LOCATION_WRITE_THROTTLE_SECONDS = 10;

/**
 * Distances are rounded to this many metres before leaving the API.
 *
 * The stored value is already approximate; rounding it further means repeated
 * searches cannot be averaged back into a precise position, while a 5 km search
 * still reads sensibly ("about 1.3 km away").
 */
export const DISTANCE_ROUNDING_METERS = 50;

/** Metres per degree of latitude, and of longitude at the equator. */
const METERS_PER_DEGREE = 111_320;

export function clampRadiusMeters(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RADIUS_METERS;
  return Math.min(MAX_RADIUS_METERS, Math.max(MIN_RADIUS_METERS, Math.round(value)));
}

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

/** Rounds a coordinate to the stored precision, matching `ROUND(x, 4)` in SQL. */
export function roundCoordinate(value: number, decimals: number = COORDINATE_PRECISION_DECIMALS): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function roundDistance(meters: number): number {
  return Math.round(meters / DISTANCE_ROUNDING_METERS) * DISTANCE_ROUNDING_METERS;
}

export interface BoundingBox {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

/**
 * The geographic bounding box around a radius search - the prefilter that lets
 * MySQL use the spatial index, with the exact distance test applied afterwards.
 *
 * Two edges are handled explicitly rather than ignored:
 *
 *   * **The poles.** `minLatitude` / `maxLatitude` are clamped to +/-90, so a box
 *     near a pole becomes a run of full-width latitude bands. Widening a
 *     prefilter is safe: the exact `ST_Distance_Sphere` test that follows
 *     discards anything the box let through.
 *   * **The antimeridian.** Longitude is a circle, and at a longitude delta wide
 *     enough to wrap past +/-180 a rectangular box cannot represent the region.
 *     Rather than silently dropping members standing either side of it, the box
 *     is widened to the full [-180, 180] range. Again: fewer rows are excluded
 *     than necessary, none that should match are lost.
 *
 * The degrees-to-metres conversion is the flat-earth approximation, which is
 * what makes a *prefilter* cheap; it is not used for any answer.
 */
export function boundingBox(latitude: number, longitude: number, radiusMeters: number): BoundingBox {
  const latitudeDelta = radiusMeters / METERS_PER_DEGREE;

  const cosine = Math.cos((latitude * Math.PI) / 180);
  // At the poles a degree of longitude shrinks to nothing, so the box would have
  // to span every meridian. The guard keeps the division finite.
  const longitudeDelta = cosine <= 1e-6 ? 180 : radiusMeters / (METERS_PER_DEGREE * cosine);

  const minLatitude = Math.max(-90, latitude - latitudeDelta);
  const maxLatitude = Math.min(90, latitude + latitudeDelta);

  const wrapsAntimeridian = longitude - longitudeDelta < -180 || longitude + longitudeDelta > 180;

  return {
    minLatitude,
    maxLatitude,
    minLongitude: wrapsAntimeridian ? -180 : longitude - longitudeDelta,
    maxLongitude: wrapsAntimeridian ? 180 : longitude + longitudeDelta,
  };
}

/**
 * Geographic helpers shared by the location layer, the People screen and the
 * security tests.
 *
 * Everything here is a pure function over metres / ISO timestamps, so the
 * ranking and privacy rules can be unit-tested without a device or a network.
 * These values must stay in sync with `backend/src/domain/geo.ts` (radius bounds,
 * write throttle) - the server is the authority, the client only mirrors the
 * bounds for a good UX.
 */

/** Default search radius for nearby discovery (metres). */
export const DEFAULT_RADIUS_METERS = 5000;

/** Smallest radius the backend will honour (metres). */
export const MIN_RADIUS_METERS = 1000;

/** Largest radius the backend will honour (metres). */
export const MAX_RADIUS_METERS = 10000;

/**
 * Whether the member has a nearby area saved.
 *
 * The area is not a cache: the server keeps it until its owner replaces it,
 * turns nearby discovery off or closes the account, so this answers "is there
 * something to search from?" and never "is it still recent enough?".
 */
export function hasSavedLocation(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false;
  return !Number.isNaN(Date.parse(updatedAt));
}

/** Coordinates are rounded to this many decimal places before storage (~11 m). */
export const COORDINATE_PRECISION_DECIMALS = 4;

export interface RadiusOption {
  id: string;
  label: string;
  meters: number;
}

/** The radius choices offered in the UI (1 / 5 / 10 km). */
export const RADIUS_OPTIONS: readonly RadiusOption[] = [
  { id: '1000', label: '1 km', meters: MIN_RADIUS_METERS },
  { id: '5000', label: '5 km', meters: DEFAULT_RADIUS_METERS },
  { id: '10000', label: '10 km', meters: MAX_RADIUS_METERS },
];

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

export function formatRadiusLabel(meters: number): string {
  const rounded = clampRadiusMeters(meters);
  return rounded % 1000 === 0 ? `${rounded / 1000} km` : `${rounded} m`;
}

/**
 * Converts a distance into a deliberately coarse label.
 *
 * Exact distances are never shown: the API only ever returns an approximation,
 * and this formatting rounds it further so a reader cannot triangulate someone's
 * position from repeated searches.
 */
export function formatApproximateDistance(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters) || meters < 0) return null;
  if (meters < 250) return 'Less than 250 m away';
  if (meters < 1000) return `About ${Math.round(meters / 100) * 100} m away`;
  if (meters < 10000) return `About ${(meters / 1000).toFixed(1)} km away`;
  return `About ${Math.round(meters / 1000)} km away`;
}

/**
 * "Saved 5 minutes ago"-style copy for the nearby-area indicator.
 *
 * Deliberately vague past a few minutes: the exact timestamp of a saved area is
 * itself sensitive, and the only decision the reader has to make is whether to
 * update it. There is no "too old" state any more - the area a member chose
 * stays in force until they replace it, turn nearby discovery off or close their
 * account.
 */
export function formatLocationAge(updatedAt: string | null | undefined, nowMs: number = Date.now()): string {
  if (!updatedAt) return 'No nearby area saved yet';
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(updated)) return 'Save time unavailable';

  const minutes = Math.max(0, Math.round((nowMs - updated) / 60000));
  if (minutes < 1) return 'Saved just now';
  if (minutes < 60) return `Saved ${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Saved ${hours} h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `Saved ${days} ${days === 1 ? 'day' : 'days'} ago`;
  return 'Saved over a month ago';
}

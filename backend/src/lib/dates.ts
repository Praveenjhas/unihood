/**
 * Timestamp formatting for API responses.
 *
 * The database stores `DATETIME(3)` with no zone, and `db/pool.ts` pins every
 * connection to UTC. The wire format is therefore always
 * `2026-10-10T12:34:56.789Z` - the same shape the previous Supabase project
 * returned, so the mobile client's `Date.parse`-based helpers
 * (`isLocationFresh`, `formatLocationAge`) keep working unchanged.
 */
export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isoFromNow(offsetSeconds: number): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

/** `Date` a number of seconds from now, for a column that wants a value. */
export function dateFromNow(offsetSeconds: number): Date {
  return new Date(Date.now() + offsetSeconds * 1000);
}

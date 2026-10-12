/**
 * Location data access.
 *
 * The client never writes a coordinate into a table, and it can never read one
 * back: `PUT /api/location/me` binds the write to the caller's session, requires
 * nearby-discovery consent, bounds and rounds the coordinates (~11 m) and
 * throttles writes to one per 10 s.
 *
 * There is no "get my location" call on purpose. The only thing the app needs to
 * know is *when* the fix was taken, which the API returns from the write and the
 * profile row carries afterwards (`locationUpdatedAt`).
 */
import { apiRequest } from '../../lib';

/** One-shot accuracy request. Coarse on purpose: the server rounds anyway. */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface StoredLocation {
  /** Server timestamp of the stored fix, or `null` if the write was throttled. */
  locationUpdatedAt: string | null;
}

/**
 * Stores the caller's rounded location.
 *
 * Fails with `nearby_disabled` when nearby discovery is switched off for the
 * account and `validation_error` for out-of-range - or exactly 0,0, which is what
 * a GPS hands out when it has no fix at all. `describeError` turns both into a
 * sentence the member can act on.
 */
export async function updateMyLocation({ latitude, longitude }: Coordinates): Promise<StoredLocation> {
  const payload = await apiRequest<{ locationUpdatedAt?: string | null }>('/api/location/me', {
    method: 'PUT',
    body: { latitude, longitude },
  });

  return { locationUpdatedAt: payload?.locationUpdatedAt ?? null };
}

/**
 * Deletes the stored fix. Safe when nothing is stored, and the app calls it
 * whenever a member withdraws consent, so "stop sharing" is true even before the
 * profile write lands.
 */
export async function forgetMyLocation(): Promise<void> {
  await apiRequest('/api/location/me', { method: 'DELETE' });
}

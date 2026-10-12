/**
 * Location storage.
 *
 * Nothing in this module ever returns a coordinate to a caller. The stored fix
 * is written, deleted, or used internally to compute a distance - that is the
 * whole surface. The client learns only *when* the fix was taken, exactly as the
 * Supabase `set_my_location` / `clear_my_location` pair allowed, plus the two
 * rules Supabase enforced inside the function:
 *
 *   * **consent** - `nearby_discovery_enabled` must be on, checked under a row
 *     lock inside the same transaction as the write;
 *   * **a write throttle** - a second write within
 *     `LOCATION_WRITE_THROTTLE_SECONDS` keeps the existing timestamp rather than
 *     failing, because the member's intent ("I am here now") is already
 *     satisfied and an error would only need explaining.
 *
 * A stored fix is not a cache: it does not expire, and nothing here deletes it on
 * a timer. The area a member chose stays exactly where they left it until they
 * save a new one, switch nearby discovery off (which `profileService` turns into
 * the same delete) or delete their account - which is what lets someone change
 * the area they are found in without standing in it.
 *
 * Coordinates are rounded to ~11 m before they are stored, so the database never
 * holds a precise position even for its own owner.
 */
import type { RowDataPacket } from 'mysql2/promise';

import { pool, withTransaction } from '../db/pool';
import {
  COORDINATE_PRECISION_DECIMALS,
  LOCATION_WRITE_THROTTLE_SECONDS,
  isValidLatitude,
  isValidLongitude,
  roundCoordinate,
} from '../domain/geo';
import { toIso } from '../lib/dates';
import { AppError } from '../lib/errors';

export interface StoredLocation {
  /** Server timestamp of the stored fix; `null` if nothing is stored. */
  locationUpdatedAt: string | null;
}

export interface CallerCoordinates {
  latitude: number;
  longitude: number;
}

interface ProfileConsentRow extends RowDataPacket {
  nearby_discovery_enabled: number;
}

interface LocationRow extends RowDataPacket {
  location_updated_at: Date;
}

interface CoordinateRow extends RowDataPacket {
  latitude: number;
  longitude: number;
}

/**
 * The caller's own saved area, if there is one.
 *
 * Feeds the distance calculations in `peopleService` - and because it is only
 * ever the caller's own row, the search origin can never be supplied by the
 * client, so "who is near this address?" is not a question the API can answer.
 *
 * There is no age test: a fix saved months ago is still the area its owner last
 * chose, and searching from it is exactly what "keep my nearby area" means. The
 * id is bound, and the statement reads one row, so nothing here depends on a
 * client value.
 */
export async function findStoredLocation(userId: string): Promise<CallerCoordinates | null> {
  const [rows] = await pool.query<CoordinateRow[]>(
    `SELECT latitude, longitude
       FROM user_locations
      WHERE user_id = ?
      LIMIT 1`,
    [userId],
  );

  const row = rows[0];
  return row ? { latitude: Number(row.latitude), longitude: Number(row.longitude) } : null;
}

/**
 * Deletes the stored fix.
 *
 * Safe to call when nothing is stored - which is what lets the client make
 * "stop sharing" true immediately, without waiting for the profile write that
 * normally performs the same delete.
 */
export async function clearMyLocation(userId: string): Promise<void> {
  await pool.query('DELETE FROM user_locations WHERE user_id = ?', [userId]);
}

/** Stores the caller's rounded location. Requires nearby-discovery consent. */
export async function setMyLocation(
  userId: string,
  latitude: number,
  longitude: number,
): Promise<StoredLocation> {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    throw new AppError(
      'validation_error',
      400,
      'Latitude must be between -90 and 90 and longitude between -180 and 180.',
      { field: 'location' },
    );
  }

  // (0, 0) is what a GPS hands out when it has no fix at all; storing it would
  // silently place the member in the Gulf of Guinea.
  if (latitude === 0 && longitude === 0) {
    throw new AppError(
      'validation_error',
      400,
      'That reading looks like a missing fix. Move somewhere with a clearer signal and try again.',
      { field: 'location' },
    );
  }

  return withTransaction(async (connection) => {
    // Consent is read under a lock so a concurrent profile write that switches it
    // off cannot slip between the check and the insert.
    const [consentRows] = await connection.query<ProfileConsentRow[]>(
      'SELECT nearby_discovery_enabled FROM profiles WHERE user_id = ? FOR UPDATE',
      [userId],
    );

    const consent = consentRows[0];
    if (!consent) {
      throw new AppError('profile_not_found', 404, 'Your profile could not be found. Sign out and in again.');
    }
    if (consent.nearby_discovery_enabled !== 1) {
      throw new AppError(
        'nearby_disabled',
        403,
        'Nearby discovery is switched off for this account. Turn it on in your profile to share a location.',
      );
    }

    const [existingRows] = await connection.query<LocationRow[]>(
      'SELECT location_updated_at FROM user_locations WHERE user_id = ?',
      [userId],
    );

    const existing = existingRows[0];
    if (existing && Date.now() - existing.location_updated_at.getTime() < LOCATION_WRITE_THROTTLE_SECONDS * 1000) {
      return { locationUpdatedAt: toIso(existing.location_updated_at) };
    }

    const roundedLatitude = roundCoordinate(latitude, COORDINATE_PRECISION_DECIMALS);
    const roundedLongitude = roundCoordinate(longitude, COORDINATE_PRECISION_DECIMALS);

    // Longitude first: `ST_SRID(POINT(x, y), 0)`, x = longitude, y = latitude -
    // verified against this MySQL 8.0.35 server (see README -> Spatial query design).
    await connection.query(
      `INSERT INTO user_locations (user_id, latitude, longitude, location, location_updated_at)
       VALUES (?, ?, ?, ST_SRID(POINT(?, ?), 0), NOW(3)) AS incoming
       ON DUPLICATE KEY UPDATE
         latitude = incoming.latitude,
         longitude = incoming.longitude,
         location = incoming.location,
         location_updated_at = NOW(3)`,
      [userId, roundedLatitude, roundedLongitude, roundedLongitude, roundedLatitude],
    );

    const [savedRows] = await connection.query<LocationRow[]>(
      'SELECT location_updated_at FROM user_locations WHERE user_id = ?',
      [userId],
    );

    return { locationUpdatedAt: toIso(savedRows[0]?.location_updated_at ?? null) };
  });
}

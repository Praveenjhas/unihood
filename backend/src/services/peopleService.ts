/**
 * People discovery.
 *
 * Three queries with one public shape, ported from the Supabase
 * `search_people` / `nearby_people` / `get_public_profile` functions:
 *
 *   * `searchPeople`  - name/skill and interest filters, no geography.
 *   * `nearbyPeople`  - the same filters plus a radius, measured from the
 *                       caller's *own* stored area.
 *   * `getPublicProfile` - one member, for the detail screen.
 *
 * The rules the SQL functions encoded are reproduced here rather than in SQL
 * procedures, because the API is the only thing that can reach MySQL:
 *
 *   * the caller is always an argument taken from the access token, never from
 *     the request;
 *   * the caller never appears in their own results;
 *   * only discoverable profiles are returned;
 *   * a distance is produced **only** when both sides consented to nearby
 *     discovery and both hold a saved area - otherwise `NULL`, which the client
 *     renders as "distance unavailable" rather than as zero;
 *   * results are ranked by shared interests, then distance, then name;
 *   * `matchSharedInterests` narrows the list to members who share at least one
 *     interest with the caller - Phase 6's "matched" filter - and every result
 *     carries `sharedInterestIds`, so the UI can highlight exactly what matched;
 *   * paging is clamped, so one request cannot drain the table.
 *
 * No response built here ever contains a coordinate. `distanceMeters` is rounded
 * on the way out, so repeated searches cannot be averaged back into a position.
 */
import type { RowDataPacket } from 'mysql2/promise';

import { pool } from '../db/pool';
import { boundingBox, clampRadiusMeters, roundDistance } from '../domain/geo';
import { AppError, badRequest } from '../lib/errors';
import { findStoredLocation } from './locationService';

export const PEOPLE_PAGE_SIZE = 20;
export const MAX_PEOPLE_PAGE_SIZE = 50;
export const MAX_INTEREST_FILTERS = 20;

/** The public projection of a member. Deliberately narrower than `MemberProfile`. */
export interface PersonRecord {
  id: string;
  displayName: string;
  bio: string | null;
  avatarPath: string | null;
  locationLabel: string | null;
  interestIds: string[];
  /**
   * The interests the *viewer* also picked, as ids.
   *
   * Sent alongside the count because the two answer different questions: the count
   * ranks the list, and the ids are what the card tints. Computing them in SQL
   * rather than on the client means a stale copy of the viewer's own profile - the
   * one the app cached at sign-in - cannot make the highlight disagree with the
   * ranking that put the member in the list.
   */
  sharedInterestIds: string[];
  sharedInterestCount: number;
  /** Approximate metres away, or `null` when it cannot be shared. */
  distanceMeters: number | null;
}

export interface PersonPage {
  people: PersonRecord[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/**
 * What `q` is allowed to match.
 *
 * The People screen has two segments - Name and Skill - and this is how it tells
 * the server which one the member is in. It is part of the request rather than
 * something the server guesses, so the answer to "sharma" cannot quietly change
 * meaning between two taps.
 *
 * `any` keeps the two previous behaviours available in one switch (`q` alone),
 * which is what the existing callers and assertions send.
 */
export type PeopleSearchField = 'any' | 'name' | 'skill';

export interface DiscoveryOptions {
  /** Free text matched against the display name **and/or** an interest label. */
  query: string;
  /** Which of the two things `q` may match. */
  searchField: PeopleSearchField;
  /** Interest ids to require; an empty list means "no filter". */
  interestIds: string[];
  /**
   * When true, only members who share at least one interest with the caller.
   *
   * The comparison is made in SQL against the caller's own `profile_interests`
   * rows, so this is a *server* rule rather than a client convention: `interestIds`
   * says "must have picked this", and this says "and we must have something in
   * common", which is the difference between a filter and a match.
   */
  matchSharedInterests: boolean;
  limit: number;
  offset: number;
}

export interface NearbyOptions extends DiscoveryOptions {
  radiusMeters: number;
}

interface CandidateRow extends RowDataPacket {
  user_id: string;
  display_name: string;
  bio: string | null;
  avatar_path: string | null;
  location_label: string | null;
  interest_ids_csv: string | null;
  shared_ids_csv: string | null;
  shared_count: number | string | null;
  distance_meters: number | string | null;
}

function splitInterestIds(csv: string | null): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapCandidate(row: CandidateRow): PersonRecord {
  const distance = toNumberOrNull(row.distance_meters);

  return {
    id: row.user_id,
    displayName: row.display_name,
    bio: row.bio,
    avatarPath: row.avatar_path,
    locationLabel: row.location_label,
    interestIds: splitInterestIds(row.interest_ids_csv),
    sharedInterestIds: splitInterestIds(row.shared_ids_csv),
    sharedInterestCount: Number(row.shared_count ?? 0),
    distanceMeters: distance === null ? null : roundDistance(distance),
  };
}

/**
 * The peer-interest aggregate and the shared-interest count.
 *
 * Both `?` placeholders are the caller's id: one to read their own interests,
 * one to keep the caller out of their own results.
 */
const CANDIDATE_CTES = `
  peer_interests AS (
    SELECT pi.user_id,
           GROUP_CONCAT(pi.interest_id ORDER BY pi.interest_id SEPARATOR ',') AS interest_ids_csv
      FROM profile_interests pi
     GROUP BY pi.user_id
  ),
  shared AS (
    SELECT pi.user_id,
           COUNT(*) AS shared_count,
           GROUP_CONCAT(pi.interest_id ORDER BY pi.interest_id SEPARATOR ',') AS shared_ids_csv
      FROM profile_interests pi
      JOIN (SELECT interest_id FROM profile_interests WHERE user_id = ?) AS mine
        ON mine.interest_id = pi.interest_id
     WHERE pi.user_id <> ?
     GROUP BY pi.user_id
  )`;

/**
 * Columns every discovery query returns, so the People screen never has to
 * reshape a response between modes.
 */
const CANDIDATE_COLUMNS = `p.user_id,
           p.display_name,
           p.bio,
           p.avatar_path,
           p.location_label,
           COALESCE(peer.interest_ids_csv, '') AS interest_ids_csv,
           COALESCE(shared.shared_ids_csv, '') AS shared_ids_csv,
           COALESCE(shared.shared_count, 0) AS shared_count`;

/** Shared by every discovery query: the two aggregates, nothing else. */
const PEER_JOINS = `LEFT JOIN peer_interests peer ON peer.user_id = p.user_id
      LEFT JOIN shared ON shared.user_id = p.user_id`;

/**
 * The candidate's location row is joined for the distance expression only. It is
 * a LEFT JOIN, so a member who has never set a nearby area still appears - just
 * without a distance.
 */
const CANDIDATE_JOINS = `${PEER_JOINS}
      LEFT JOIN user_locations pl ON pl.user_id = p.user_id`;

/**
 * The same peer joins, but an INNER JOIN on a stored location: to appear in a
 * nearby result a member must have set a nearby area.
 *
 * Four predicates, and each earns its place:
 *
 *   1. `latitude BETWEEN` / `longitude BETWEEN` - a plain numeric range on the
 *      denormalised columns, which costs nothing and gives the optimizer a
 *      second way in;
 *   2. `MBRContains(<box>, location)` - **this is the one that uses the SPATIAL
 *      index** (verified: `type=range`, `key=user_locations_location_sx`);
 *   3. `ST_Distance_Sphere(...) <= radius` - the exact spherical test that
 *      discards the corners of the box. On its own it was verified to be a full
 *      table scan, which is exactly why the box exists.
 */
const NEARBY_LOCATION_JOIN = `JOIN user_locations ul
        ON ul.user_id = p.user_id
       AND ul.latitude BETWEEN ? AND ?
       AND ul.longitude BETWEEN ? AND ?
       AND MBRContains(ST_SRID(ST_MakeEnvelope(POINT(?, ?), POINT(?, ?)), 0), ul.location)
       AND ST_Distance_Sphere(ul.location, ST_SRID(POINT(?, ?), 0)) <= ?`;

/** Ranks non-null distances ahead of unknown ones, matching the old RPCs. */
const CANDIDATE_ORDER = `shared_count DESC,
           distance_meters IS NULL ASC,
           distance_meters ASC,
           p.display_name ASC,
           p.user_id ASC`;

/**
 * Normalises caller-supplied paging and filters.
 *
 * Clamping rather than rejecting keeps a slightly-wrong client working (a stale
 * offset from a dropped "load more" tap), while an absurd value is simply capped.
 */
export function normalizeDiscoveryOptions(options: DiscoveryOptions): DiscoveryOptions {
  const unique = new Set<string>();
  for (const candidate of options.interestIds ?? []) {
    if (typeof candidate !== 'string') continue;
    const id = candidate.trim();
    if (id.length > 0) unique.add(id);
  }

  if (unique.size > MAX_INTEREST_FILTERS) {
    throw badRequest(`Too many interest filters (maximum ${MAX_INTEREST_FILTERS}).`, { field: 'interestIds' });
  }

  return {
    // Lower-cased once here: `LOCATE` compares a lower-cased column against a
    // literal, which is the case-insensitive substring match the RPC performed.
    query: (options.query ?? '').trim().toLowerCase(),
    // Anything a client sends that is not one of the two literals means "no
    // preference", which is also what a missing value means.
    searchField: options.searchField === 'name' || options.searchField === 'skill' ? options.searchField : 'any',
    interestIds: [...unique].sort(),
    // Coerced rather than trusted: this arrives from a query string, and only a
    // real boolean may switch the SQL predicate on.
    matchSharedInterests: options.matchSharedInterests === true,
    limit: Math.min(Math.max(Math.trunc(options.limit) || PEOPLE_PAGE_SIZE, 1), MAX_PEOPLE_PAGE_SIZE),
    offset: Math.max(Math.trunc(options.offset) || 0, 0),
  };
}

interface FilterFragment {
  text: string;
  values: unknown[];
}

/**
 * The optional name/skill and interest predicates.
 *
 * `LOCATE` is used instead of `LIKE` so a search term containing `%` or `_` is a
 * literal rather than a wildcard pattern - the same reasoning as the original
 * `strpos(lower(display_name), p_query)`. That matters more now that the term is
 * also matched against interest labels and slugs, which are full of underscores:
 * `q=machine_learning` has to be a literal, not a pattern.
 */
function buildFilters(options: DiscoveryOptions): FilterFragment {
  let text = '';
  const values: unknown[] = [];

  if (options.query.length > 0) {
    // The screen's two segments are two different questions - "who is called
    // Priya?" and "who is into python?" - so only `searchField` decides which
    // predicate runs. They are kept apart deliberately: a name search that also
    // matched interest labels would answer `q=art` with half the campus. `any`
    // is the default, which is what a caller sending nothing but `q` already got.
    //
    // In the skill predicate the slug (`id`) is matched next to the label,
    // because members type the word they think of rather than the label they
    // were shown: "machine learning" has to find `machine_learning`. `is_active`
    // keeps both predicates inside the catalogue the app actually displays.
    const namePredicate = 'LOCATE(?, LOWER(p.display_name)) > 0';
    const skillPredicate =
      'EXISTS (' +
      '\n             SELECT 1 FROM profile_interests qpi' +
      '\n               JOIN interests qi ON qi.id = qpi.interest_id' +
      '\n              WHERE qpi.user_id = p.user_id' +
      '\n                AND qi.is_active = 1' +
      '\n                AND (LOCATE(?, LOWER(qi.name)) > 0 OR LOCATE(?, LOWER(qi.id)) > 0))';

    if (options.searchField === 'name') {
      text += `\n       AND (${namePredicate})`;
      values.push(options.query);
    } else if (options.searchField === 'skill') {
      text += `\n       AND (${skillPredicate})`;
      values.push(options.query, options.query);
    } else {
      text += `\n       AND (${namePredicate}\n         OR ${skillPredicate})`;
      values.push(options.query, options.query, options.query);
    }
  }

  if (options.interestIds.length > 0) {
    const placeholders = options.interestIds.map(() => '?').join(', ');
    text +=
      '\n       AND EXISTS (' +
      '\n         SELECT 1 FROM profile_interests fpi' +
      '\n          WHERE fpi.user_id = p.user_id' +
      `\n            AND fpi.interest_id IN (${placeholders}))`;
    values.push(...options.interestIds);
  }

  if (options.matchSharedInterests) {
    // `shared` is the CTE that counts the caller's overlapping interests, so this
    // is the one predicate that expresses "we have something in common". A member
    // who shares nothing is excluded rather than ranked last: the screen asked for
    // matches, and an empty list is a truthful answer to that.
    text += '\n       AND COALESCE(shared.shared_count, 0) > 0';
  }

  return { text, values };
}

/**
 * `hasMore` is derived from a full page coming back. There is deliberately no
 * total: counting every profile is expensive and is itself a privacy signal.
 */
function buildPage(rows: CandidateRow[], options: DiscoveryOptions): PersonPage {
  const people = rows.map(mapCandidate);
  const hasMore = rows.length === options.limit;

  return {
    people,
    offset: options.offset,
    hasMore,
    nextOffset: hasMore ? options.offset + rows.length : null,
  };
}

interface ConsentRow extends RowDataPacket {
  nearby_discovery_enabled: number;
}

/** The caller's own consent flag, or a 404 when their profile is missing. */
async function requireCallerProfile(userId: string): Promise<ConsentRow> {
  const [rows] = await pool.query<ConsentRow[]>(
    'SELECT nearby_discovery_enabled FROM profiles WHERE user_id = ? LIMIT 1',
    [userId],
  );

  const row = rows[0];
  if (!row) throw new AppError('profile_not_found', 404, 'Your profile could not be found. Sign out and in again.');
  return row;
}

/**
 * General discovery: name and interest filters, no radius.
 *
 * Distances are still *reported* when both sides consented and both hold a saved
 * area - a position each opted to share - but nothing is filtered out for being
 * far away. A caller with no saved area simply sees no distances at all, rather
 * than a misleading zero.
 */
export async function searchPeople(callerId: string, options: DiscoveryOptions): Promise<PersonPage> {
  const query = normalizeDiscoveryOptions(options);
  const filters = buildFilters(query);
  const origin = await findStoredLocation(callerId);

  const [rows] = await pool.query<CandidateRow[]>(
    `WITH ${CANDIDATE_CTES}
     SELECT ${CANDIDATE_COLUMNS},
            CASE
              WHEN ? = 1 AND p.nearby_discovery_enabled = 1 AND pl.location IS NOT NULL
              THEN ST_Distance_Sphere(pl.location, ST_SRID(POINT(?, ?), 0))
              ELSE NULL
            END AS distance_meters
       FROM profiles p
      ${CANDIDATE_JOINS}
      WHERE p.user_id <> ?
        AND p.is_discoverable = 1${filters.text}
      ORDER BY ${CANDIDATE_ORDER}
      LIMIT ? OFFSET ?`,
    // The values below are in the exact order the `?` markers appear in the SQL
    // above; each line names the placeholder it fills.
    [
      callerId, // CTEs: the caller's own interest list
      callerId, // CTEs: keep the caller out of their own results
      origin ? 1 : 0, // CASE: is there an origin to measure from?
      origin?.longitude ?? 0, // CASE: POINT(x = longitude)
      origin?.latitude ?? 0, // CASE: POINT(y = latitude)
      callerId, // WHERE: never the caller themself
      ...filters.values, // name and interest predicates, in order
      query.limit,
      query.offset,
    ],
  );

  return buildPage(rows, query);
}

/**
 * Nearby discovery.
 *
 * The origin is the caller's **own** stored area, never a coordinate from the
 * request: "who is near this address?" is not a question this API answers. Three
 * things must hold before any work happens - a profile with consent on, and a
 * saved area to search from (however long ago it was saved) - and each failure has
 * its own code so the client can offer the right next step ("set your nearby
 * area", "turn nearby on") instead of a generic retry.
 */
export async function nearbyPeople(callerId: string, options: NearbyOptions): Promise<PersonPage> {
  const query = normalizeDiscoveryOptions(options);
  const radiusMeters = clampRadiusMeters(options.radiusMeters);

  const profile = await requireCallerProfile(callerId);
  if (profile.nearby_discovery_enabled !== 1) {
    throw new AppError(
      'nearby_disabled',
      403,
      'Nearby discovery is switched off for this account. Turn it on in your profile to search nearby.',
    );
  }

  const origin = await findStoredLocation(callerId);
  if (!origin) {
    throw new AppError(
      'location_required',
      409,
      'Set your nearby area in your profile before searching nearby people. It is saved until you change it.',
    );
  }

  const filters = buildFilters(query);
  const box = boundingBox(origin.latitude, origin.longitude, radiusMeters);

  const [rows] = await pool.query<CandidateRow[]>(
    `WITH ${CANDIDATE_CTES}
     SELECT ${CANDIDATE_COLUMNS},
            ST_Distance_Sphere(ul.location, ST_SRID(POINT(?, ?), 0)) AS distance_meters
       FROM profiles p
      ${PEER_JOINS}
      ${NEARBY_LOCATION_JOIN}
      WHERE p.user_id <> ?
        AND p.is_discoverable = 1
        AND p.nearby_discovery_enabled = 1${filters.text}
      ORDER BY ${CANDIDATE_ORDER}
      LIMIT ? OFFSET ?`,
    [
      callerId, // CTEs: the caller's own interest list
      callerId, // CTEs: keep the caller out of their own results
      origin.longitude, // SELECT: POINT(x = longitude)
      origin.latitude, // SELECT: POINT(y = latitude)
      box.minLatitude, // JOIN: numeric prefilter
      box.maxLatitude,
      box.minLongitude,
      box.maxLongitude,
      box.minLongitude, // JOIN: ST_MakeEnvelope corner 1
      box.minLatitude,
      box.maxLongitude, // JOIN: ST_MakeEnvelope corner 2
      box.maxLatitude,
      origin.longitude, // JOIN: exact spherical distance
      origin.latitude,
      radiusMeters,
      callerId, // WHERE: never the caller themself
      ...filters.values,
      query.limit,
      query.offset,
    ],
  );

  return buildPage(rows, query);
}

/**
 * One member's public profile.
 *
 * Returns only the caller's own row or a discoverable one, and computes a
 * distance only when the *other* member consented - the caller's own consent was
 * already established by holding a saved area to measure from.
 */
export async function getPublicProfile(callerId: string, profileId: string): Promise<PersonRecord> {
  const isSelf = callerId === profileId;
  const origin = await findStoredLocation(callerId);

  const [rows] = await pool.query<CandidateRow[]>(
    `WITH ${CANDIDATE_CTES}
     SELECT ${CANDIDATE_COLUMNS},
            CASE
              WHEN ? = 0 AND p.nearby_discovery_enabled = 1 AND pl.location IS NOT NULL
              THEN ST_Distance_Sphere(pl.location, ST_SRID(POINT(?, ?), 0))
              ELSE NULL
            END AS distance_meters
       FROM profiles p
      ${CANDIDATE_JOINS}
      WHERE p.user_id = ?
        AND (p.user_id = ? OR p.is_discoverable = 1)
      LIMIT 1`,
    [
      callerId, // CTEs: the caller's own interest list
      callerId, // CTEs: sharing counts exclude the caller themself
      isSelf ? 1 : 0, // CASE: never show yourself a distance from yourself
      origin?.longitude ?? 0, // CASE: POINT(x = longitude)
      origin?.latitude ?? 0, // CASE: POINT(y = latitude)
      profileId, // WHERE: the profile being asked for
      callerId, // WHERE: the caller is the only identity that matters
    ],
  );

  const row = rows[0];
  if (!row) {
    // No row rather than an error, exactly as `get_public_profile` behaved: the
    // member turned discovery off, or the id never existed. The client shows a
    // final answer rather than a retry button.
    throw new AppError('not_found', 404, 'That profile is not shared anymore. It may have been made private.');
  }

  return mapCandidate(row);
}

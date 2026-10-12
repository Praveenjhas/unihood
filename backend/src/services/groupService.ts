/**
 * Groups, memberships and the rules that hold them together.
 *
 * This is the only module that knows the shape of `groups`, `group_locations` and
 * `group_memberships`, and it holds every authorization rule for the phase. The
 * rules live here rather than in the route layer because the routes are just the
 * HTTP surface: a rule enforced here is enforced for every caller, including a
 * hand-written request that never went near the mobile app.
 *
 * The four properties worth stating up front, because the SQL below is written to
 * preserve them:
 *
 *   1. **Identity comes from the token.** No function takes a user id from a body
 *      or a query string; the caller's id is always an argument supplied by
 *      `requireAuth`.
 *   2. **Discovery never leaks membership.** A private group's preview carries the
 *      group's own facts (name, category, member *count*) and nothing about who is
 *      in it. Member lists and join-request queues are separate endpoints that
 *      re-check the caller's role.
 *   3. **Eligibility is read, never trusted.** The audience check reads the
 *      caller's own `profiles.group_eligibility_gender` inside the same
 *      transaction as the write, so a client-supplied value cannot influence it.
 *   4. **Nothing is deleted.** Archiving writes `archived_at`; every listing and
 *      every mutation refuses an archived group with `group_archived`.
 *
 * `groups` is a reserved word in MySQL 8, so the table is written as `` `groups` ``
 * in every statement here - see the header of `migrations/0006_groups.sql`.
 */
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { pool, withTransaction } from '../db/pool';
import {
  COORDINATE_PRECISION_DECIMALS,
  boundingBox,
  clampRadiusMeters,
  isValidLatitude,
  isValidLongitude,
  roundCoordinate,
  roundDistance,
} from '../domain/geo';
import {
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_LOCATION_LABEL_MAX_LENGTH,
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_MIN_LENGTH,
  MAX_GROUP_INTEREST_FILTERS,
  MAX_GROUP_PAGE_SIZE,
  MAX_MEMBERSHIP_PAGE_SIZE,
  isEligibleForAudience,
  type GroupAudience,
  type GroupCategoryId,
  type GroupEligibility,
  type GroupVisibility,
  type MembershipRole,
  type MembershipStatus,
} from '../domain/groups';
import { toIso } from '../lib/dates';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { VENUE_LABEL_REQUIRED_MESSAGE, venueLabelProblem } from '../domain/venue';
import { evictGroupRoom, evictUserFromGroup } from '../realtime/hub';
import { newId } from '../lib/tokens';
import { activeInterestIds } from './interestService';
import { findStoredLocation } from './locationService';

// -----------------------------------------------------------------------------
// The public shape of a group
// -----------------------------------------------------------------------------

/** The viewer's own relationship to a group, or `null` when there is none. */
export interface ViewerMembership {
  role: MembershipRole;
  status: MembershipStatus;
}

/**
 * One group as the API describes it.
 *
 * The same shape comes back from every listing, from the detail endpoint and from
 * every mutation, so the mobile client has exactly one group type to render. Two
 * fields are deliberately conditional:
 *
 *   * `owner` is `null` unless the viewer is an active member or the group is
 *     public - a private group's organiser is not public information;
 *   * `pendingRequestCount` is `null` unless the viewer may manage the group. It is
 *     a count, never a list, so it leaks nothing to a member who cannot act on it.
 *
 * `distanceMeters` is present only on a nearby search, is rounded to 50 m and is
 * `null` for a group with no geographic anchor. No coordinate is ever returned.
 */
export interface GroupSummary {
  id: string;
  name: string;
  description: string;
  category: GroupCategoryId;
  /**
   * The group's single primary interest, from the same catalogue the members pick
   * their own interests from, or `null` when the owner picked none.
   *
   * It is a group's *own* fact - never a statement about its members - so it is
   * safe on a preview. Whether the viewer shares it is what the nearby ordering
   * rewards, and the client can see that for itself by comparing this id with the
   * viewer's own interests.
   */
  interestId: string | null;
  visibility: GroupVisibility;
  audience: GroupAudience;
  locationLabel: string | null;
  hasLocation: boolean;
  distanceMeters: number | null;
  memberCount: number;
  owner: { id: string; displayName: string } | null;
  viewerMembership: ViewerMembership | null;
  viewerIsOwner: boolean;
  viewerCanManage: boolean;
  viewerEligible: boolean;
  pendingRequestCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
}

export interface GroupPage {
  groups: GroupSummary[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** One active member, for the management list. Never carries eligibility. */
export interface GroupMemberRecord {
  userId: string;
  displayName: string;
  role: MembershipRole;
  joinedAt: string | null;
}

export interface GroupMemberPage {
  members: GroupMemberRecord[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** One pending join request, for the owner/administrator queue. */
export interface GroupRequestRecord {
  userId: string;
  displayName: string;
  requestedAt: string | null;
}

export interface GroupRequestPage {
  requests: GroupRequestRecord[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** The writable half of a group, as the create and edit forms send it. */
export interface GroupDraft {
  name: string;
  description: string;
  category: GroupCategoryId;
  /** The primary interest, or `null` for "none". Validated against the catalogue. */
  interestId: string | null;
  visibility: GroupVisibility;
  audience: GroupAudience;
  locationLabel: string | null;
  /** Both or neither; `null` on create means "no geographic anchor". */
  latitude: number | null;
  longitude: number | null;
  /** Explicitly removes the stored anchor on an edit. */
  removeLocation: boolean;
}

export interface ListGroupsOptions {
  query: string;
  /** Selected category chips; an empty list means "every category". */
  categories: readonly GroupCategoryId[];
  /**
   * The interests the group's own `interest_id` must be one of; an empty list
   * means "every interest". A group with no interest therefore never appears in
   * an interest-filtered listing - it has not claimed to be about anything.
   */
  interestIds: readonly string[];
  /**
   * When true, only groups whose interest the *caller* also picked.
   *
   * The comparison runs in SQL against the caller's own `profile_interests` rows,
   * so the filter cannot be widened by anything a client sends: there is no
   * "interests" argument to lie with.
   */
  matchMyInterests: boolean;
  visibility: GroupVisibility | null;
  limit: number;
  offset: number;
}

export interface ListNearbyOptions extends ListGroupsOptions {
  radiusMeters: number;
}

export interface PageOptions {
  limit: number;
  offset: number;
}

// -----------------------------------------------------------------------------
// The projection every read is built from
// -----------------------------------------------------------------------------

interface GroupRow extends RowDataPacket {
  id: string;
  name: string;
  description: string;
  category: string;
  interest_id: string | null;
  visibility: string;
  audience: string;
  location_label: string | null;
  created_by: string;
  archived_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  owner_display_name: string | null;
  has_location: number;
  member_count: number | string;
  pending_count: number | string;
  viewer_role: string | null;
  viewer_status: string | null;
  viewer_eligibility: string | null;
  distance_meters?: number | string | null;
}

/**
 * The columns every group response needs.
 *
 * The two correlated counts are cheap because `group_memberships_group_status_idx`
 * covers `(group_id, status, role)` and a page is at most 50 rows; an aggregate
 * join would need a GROUP BY over the whole table just to count one group's rows.
 */
const GROUP_COLUMNS = `
  g.id,
  g.name,
  g.description,
  g.category,
  g.interest_id,
  g.visibility,
  g.audience,
  g.location_label,
  g.created_by,
  g.archived_at,
  g.created_at,
  g.updated_at,
  owner.display_name AS owner_display_name,
  (gl.group_id IS NOT NULL) AS has_location,
  (SELECT COUNT(*) FROM group_memberships counted
    WHERE counted.group_id = g.id AND counted.status = 'active') AS member_count,
  (SELECT COUNT(*) FROM group_memberships waiting
    WHERE waiting.group_id = g.id AND waiting.status = 'pending') AS pending_count,
  viewer.role AS viewer_role,
  viewer.status AS viewer_status,
  me.group_eligibility_gender AS viewer_eligibility
`;

/**
 * The two joins every read shares: the owner's display name and the *caller's own*
 * profile row, which is where eligibility comes from. Reading it here rather than
 * from the request is what makes a crafted `audience` or `gender` field unable to
 * change an answer.
 */
const GROUP_JOINS = `
  JOIN users owner ON owner.id = g.created_by
  JOIN profiles me ON me.user_id = ?
  LEFT JOIN group_memberships viewer ON viewer.group_id = g.id AND viewer.user_id = ?
`;

const LOCATION_LEFT_JOIN = `
  LEFT JOIN group_locations gl ON gl.group_id = g.id
`;

/**
 * A group is visible to the caller when its audience accepts them.
 *
 * The `everyone` arm comes first so the common case short-circuits, and a NULL
 * eligibility fails a restricted audience - the member has told us nothing, so the
 * server cannot assert that they qualify.
 */
const AUDIENCE_VISIBLE_SQL = `(
    g.audience = 'everyone'
    OR (g.audience = 'men_only' AND me.group_eligibility_gender = 'man')
    OR (g.audience = 'women_only' AND me.group_eligibility_gender = 'woman')
  )`;

/** A COUNT (which mysql2 may hand back as a string) or a DECIMAL -> a number. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapGroup(row: GroupRow): GroupSummary {
  const membership: ViewerMembership | null =
    row.viewer_role && row.viewer_status
      ? { role: row.viewer_role as MembershipRole, status: row.viewer_status as MembershipStatus }
      : null;

  const isActiveMember = membership?.status === 'active';
  const isOwner = isActiveMember && membership?.role === 'owner';
  const canManage = isActiveMember && (membership?.role === 'owner' || membership?.role === 'admin');
  const audience = row.audience as GroupAudience;

  // The organiser is public information on a public group. On a private group it is
  // part of what membership buys, so a non-member never sees it.
  const ownerIsVisible = isActiveMember || row.visibility === 'public';

  const distance = toNumberOrNull(row.distance_meters);

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category as GroupCategoryId,
    interestId: row.interest_id,
    visibility: row.visibility as GroupVisibility,
    audience,
    locationLabel: row.location_label,
    hasLocation: row.has_location === 1,
    distanceMeters: distance === null ? null : roundDistance(distance),
    memberCount: Number(row.member_count ?? 0),
    owner:
      ownerIsVisible && row.owner_display_name
        ? { id: row.created_by, displayName: row.owner_display_name }
        : null,
    viewerMembership: membership,
    viewerIsOwner: isOwner,
    viewerCanManage: canManage,
    viewerEligible: isEligibleForAudience(audience, (row.viewer_eligibility as GroupEligibility | null) ?? null),
    pendingRequestCount: canManage ? Number(row.pending_count ?? 0) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    archivedAt: toIso(row.archived_at),
  };
}

/**
 * Escapes the LIKE metacharacters in a search term.
 *
 * Without this a search for `%` would match every group and `_` would match any
 * single character - surprising, and a cheap way for a client to ask the database
 * for more work than it meant to.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * True when the group's primary interest is one the *caller* also picked.
 *
 * One `?` placeholder - the caller's id - and it is read from
 * `profile_interests` rather than from anything the request carries, so no client
 * can claim a match it does not have. A group with `interest_id IS NULL` is never
 * a match (NULL never equals anything), which is the honest answer: it has not
 * said what it is about.
 */
const VIEWER_INTEREST_MATCH_SQL = `EXISTS (
        SELECT 1 FROM profile_interests mine
         WHERE mine.user_id = ? AND mine.interest_id = g.interest_id
      )`;

/**
 * The shared `q` / category / interest / visibility filter, as SQL plus bound
 * values.
 *
 * `callerId` is only used by the `matchMyInterests` arm, and the caller's id is
 * always the *last* value the interest arms bind, so the placeholder order stays
 * predictable for the two listings that share this function.
 */
function buildListFilters(options: ListGroupsOptions, callerId: string): { sql: string; values: unknown[] } {
  if (options.interestIds.length > MAX_GROUP_INTEREST_FILTERS) {
    // The route layer caps this too; enforcing it here as well means a *service*
    // caller cannot ask the database to match an unbounded list of ids.
    throw badRequest(`Too many interest filters (maximum ${MAX_GROUP_INTEREST_FILTERS}).`, {
      field: 'interestIds',
    });
  }

  let sql = '';
  const values: unknown[] = [];

  const query = options.query.trim();
  if (query.length > 0) {
    const like = `%${escapeLike(query)}%`;
    sql += ' AND (g.name LIKE ? OR g.description LIKE ?)';
    values.push(like, like);
  }

  if (options.categories.length > 0) {
    // Placeholders are generated, but the *values* are always bound - the same
    // technique `interestService` uses for an IN list.
    const placeholders = options.categories.map(() => '?').join(', ');
    sql += ` AND g.category IN (${placeholders})`;
    values.push(...options.categories);
  }

  if (options.interestIds.length > 0) {
    const placeholders = options.interestIds.map(() => '?').join(', ');
    sql += ` AND g.interest_id IN (${placeholders})`;
    values.push(...options.interestIds);
  }

  if (options.matchMyInterests) {
    sql += ` AND ${VIEWER_INTEREST_MATCH_SQL}`;
    values.push(callerId);
  }

  if (options.visibility !== null) {
    sql += ' AND g.visibility = ?';
    values.push(options.visibility);
  }

  return { sql, values };
}

/**
 * Turns `limit + 1` rows into a page.
 *
 * One extra row is fetched so `hasMore` is a fact rather than a guess - otherwise a
 * full page that happens to be the last one produces a "load more" affordance that
 * returns nothing.
 */
function toGroupPage(rows: GroupRow[], options: PageOptions): GroupPage {
  const hasMore = rows.length > options.limit;
  const visible = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    groups: visible.map(mapGroup),
    offset: options.offset,
    hasMore,
    nextOffset: hasMore ? options.offset + visible.length : null,
  };
}

/** A row-level page, for the two management lists. */
function toRowPage<T>(rows: T[], options: PageOptions, pageSize: number): { items: T[]; hasMore: boolean; nextOffset: number | null } {
  const hasMore = rows.length > pageSize;
  const visible = hasMore ? rows.slice(0, pageSize) : rows;
  return {
    items: visible,
    hasMore,
    nextOffset: hasMore ? options.offset + visible.length : null,
  };
}

// -----------------------------------------------------------------------------
// Shared transaction helpers
//
// Every mutation starts by locking the group row and then the caller's membership.
// That ordering is what makes two concurrent joins resolve to one row rather than a
// duplicate-key 500, and it is why ownership changes can demote and promote inside
// one transaction.
// -----------------------------------------------------------------------------

interface GroupLockRow extends RowDataPacket {
  id: string;
  name: string;
  description: string;
  category: string;
  interest_id: string | null;
  visibility: string;
  audience: string;
  location_label: string | null;
  created_by: string;
  archived_at: Date | null;
}

interface MembershipRow extends RowDataPacket {
  id: string;
  group_id: string;
  user_id: string;
  role: string;
  status: string;
  joined_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
}

const AUDIENCE_LABEL: Record<GroupAudience, string> = {
  everyone: 'open to everyone',
  men_only: 'for men only',
  women_only: 'for women only',
};

/** Bounded paging, so one request cannot ask for the whole table. */
function clampPage(limit: number, max: number, offset: number): PageOptions {
  return {
    limit: Math.min(Math.max(Math.trunc(limit) || 1, 1), max),
    offset: Math.max(Math.trunc(offset) || 0, 0),
  };
}

/**
 * Reads and locks a group, refusing an archived one.
 *
 * `FOR UPDATE` is what serialises two simultaneous joins or two simultaneous
 * approvals against the same group, and refusing an archived group here means no
 * mutation has to remember to check for itself.
 */
async function lockGroup(connection: PoolConnection, groupId: string): Promise<GroupLockRow> {
  const [rows] = await connection.query<GroupLockRow[]>(
    `SELECT id, name, description, category, interest_id, visibility, audience, location_label, created_by, archived_at
       FROM \`groups\`
      WHERE id = ?
      FOR UPDATE`,
    [groupId],
  );

  const row = rows[0];
  if (!row) throw notFound('That group no longer exists.');
  if (row.archived_at !== null) {
    throw new AppError('group_archived', 409, 'That group has been archived, so it cannot be changed or joined.');
  }
  return row;
}

/**
 * The caller's own eligibility value, read from their profile row.
 *
 * Exported for `eventService`: a group event inherits its group's audience, so the
 * event rules need exactly this read, and re-implementing it there would be a
 * second place for "what did this member say about themselves" to drift.
 */
export async function readEligibility(connection: PoolConnection, userId: string): Promise<GroupEligibility | null> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT group_eligibility_gender AS value FROM profiles WHERE user_id = ?',
    [userId],
  );

  const row = rows[0];
  if (!row) {
    throw new AppError('profile_not_found', 404, 'Your profile could not be found. Sign out and in again.');
  }
  return (row.value ?? null) as GroupEligibility | null;
}

/**
 * Refuses a member whose self-declared eligibility does not match the audience.
 *
 * This is the only place the rule lives, so a direct `POST /join` and the mobile
 * button get the same answer. Note that it takes the value the *server* read: the
 * request body is never consulted, so a client cannot assert its own eligibility.
 */
function assertAudienceEligible(
  audience: GroupAudience,
  eligibility: GroupEligibility | null,
  action: 'create' | 'join' | 'approve',
): void {
  if (isEligibleForAudience(audience, eligibility)) return;

  const detail =
    eligibility === null
      ? 'Your profile has no eligibility setting yet, so restricted groups are closed to you for now.'
      : 'Your eligibility setting does not match this group.';

  const message =
    action === 'create'
      ? `This group would be ${AUDIENCE_LABEL[audience]}, which you can only create if your own eligibility setting matches. ${detail}`
      : `This group is ${AUDIENCE_LABEL[audience]}. ${detail}`;

  throw new AppError('audience_not_eligible', 403, message);
}

async function lockMembership(
  connection: PoolConnection,
  groupId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const [rows] = await connection.query<MembershipRow[]>(
    `SELECT id, group_id, user_id, role, status, joined_at, decided_at, decided_by
       FROM group_memberships
      WHERE group_id = ? AND user_id = ?
      FOR UPDATE`,
    [groupId, userId],
  );
  return rows[0] ?? null;
}

/**
 * The caller's role in a group, but only while they are an active member.
 *
 * Exported for `eventService`, which has to answer "may this member host for, or
 * manage, this group's events?" with the same stored row the group rules use.
 */
export async function activeRoleOf(
  connection: PoolConnection,
  groupId: string,
  userId: string,
): Promise<MembershipRole | null> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT role FROM group_memberships WHERE group_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
    [groupId, userId],
  );
  const row = rows[0];
  return row ? (row.role as MembershipRole) : null;
}

// -----------------------------------------------------------------------------
// Discovery reads
// -----------------------------------------------------------------------------

/**
 * One group, for the detail screen.
 *
 * Deliberately not filtered by audience: a member who is not eligible still gets
 * the group's own facts plus `viewerEligible: false`, which is what lets the screen
 * explain *why* the join button is absent instead of showing a 404. What a
 * non-member never gets is private membership information - the member list and the
 * request queue are separate, role-checked endpoints.
 */
export async function getGroup(callerId: string, groupId: string): Promise<GroupSummary> {
  const [rows] = await pool.query<GroupRow[]>(
    `SELECT ${GROUP_COLUMNS}
       FROM \`groups\` g
       ${GROUP_JOINS}
       ${LOCATION_LEFT_JOIN}
      WHERE g.id = ?
      LIMIT 1`,
    [callerId, callerId, groupId],
  );

  const row = rows[0];
  if (!row) throw notFound('That group no longer exists.');

  return mapGroup(row);
}

/**
 * The directory: every group the caller is eligible to discover.
 *
 * Ordered by name because a directory is something people scan; the nearby search
 * is the one that ranks, and it ranks by interest match first, then distance.
 *
 * The interest filter narrows the *directory* too, so "show me coding groups" and
 * "show me coding groups near me" ask one question in two ways. A group that has
 * claimed no interest is absent from an interest-filtered listing and present in
 * every unfiltered one, which is what keeps the listing honest both ways.
 */
export async function listGroups(callerId: string, options: ListGroupsOptions): Promise<GroupPage> {
  const page = clampPage(options.limit, MAX_GROUP_PAGE_SIZE, options.offset);
  const filters = buildListFilters(options, callerId);

  const [rows] = await pool.query<GroupRow[]>(
    `SELECT ${GROUP_COLUMNS}
       FROM \`groups\` g
       ${GROUP_JOINS}
       ${LOCATION_LEFT_JOIN}
      WHERE g.archived_at IS NULL
        AND ${AUDIENCE_VISIBLE_SQL}${filters.sql}
      ORDER BY g.name ASC, g.id ASC
      LIMIT ? OFFSET ?`,
    [callerId, callerId, ...filters.values, page.limit + 1, page.offset],
  );

  return toGroupPage(rows, page);
}

/**
 * The caller's own groups - *active memberships*, wherever they now are.
 *
 * No radius and no audience filter: an existing membership must not disappear
 * because the member moved or because they later changed their eligibility setting.
 * Archived groups are excluded; their detail screen still says so.
 */
export async function listMyGroups(callerId: string, options: PageOptions): Promise<GroupPage> {
  const page = clampPage(options.limit, MAX_GROUP_PAGE_SIZE, options.offset);

  const [rows] = await pool.query<GroupRow[]>(
    `SELECT ${GROUP_COLUMNS}
       FROM \`groups\` g
       ${GROUP_JOINS}
       ${LOCATION_LEFT_JOIN}
      WHERE g.archived_at IS NULL
        AND viewer.status = 'active'
      ORDER BY g.name ASC, g.id ASC
      LIMIT ? OFFSET ?`,
    [callerId, callerId, page.limit + 1, page.offset],
  );

  return toGroupPage(rows, page);
}

/**
 * Nearby groups, filtered by the database rather than by the client.
 *
 * This is migration 0003's spatial design applied to `group_locations`, and it is
 * worth reading alongside it:
 *
 *   * `ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 0))` - **longitude
 *     first**, because that is the axis ordering this server was measured with.
 *     Getting the pair the wrong way round silently produces distances that are
 *     wrong by thousands of kilometres.
 *   * the bounding box (`MBRContains` over `ST_MakeEnvelope`) is the index-using
 *     prefilter; the exact spherical test runs afterwards and discards the box's
 *     corners. The radius is bound in metres, and the origin is the caller's *own*
 *     stored fix - never a request field - so "who is near this address?" remains
 *     unanswerable.
 *   * a group with no `group_locations` row cannot match: the geographic conditions
 *     live in the `LEFT JOIN ... ON`, and `gl.location IS NOT NULL` is required, so
 *     an unlocated group is never presented as a confirmed nearby result.
 *   * the distance column is rounded to 50 m before it leaves `mapGroup`.
 *
 * Phase 6 adds one ordering key in front of the distance: `matched_interest`, the
 * `EXISTS` in `VIEWER_INTEREST_MATCH_SQL`, which is true when the group's primary
 * interest is one the caller also picked. Interest first, then distance, because
 * "someone who wants what I want" beats "someone marginally closer" for meeting
 * up - and because a group with no interest, or an interest the caller does not
 * share, is *still listed*: the ranking never becomes a hidden filter.
 */
export async function listNearbyGroups(callerId: string, options: ListNearbyOptions): Promise<GroupPage> {
  const page = clampPage(options.limit, MAX_GROUP_PAGE_SIZE, options.offset);
  const radiusMeters = clampRadiusMeters(options.radiusMeters);

  const origin = await findStoredLocation(callerId);
  if (!origin) {
    throw new AppError(
      'location_required',
      409,
      'Set your nearby area in your profile before searching nearby groups. It is saved until you change it.',
    );
  }

  const box = boundingBox(origin.latitude, origin.longitude, radiusMeters);
  const filters = buildListFilters(options, callerId);

  const [rows] = await pool.query<GroupRow[]>(
    `SELECT ${GROUP_COLUMNS},
            ${VIEWER_INTEREST_MATCH_SQL} AS matched_interest,
            ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 0)) AS distance_meters
       FROM \`groups\` g
       ${GROUP_JOINS}
       LEFT JOIN group_locations gl
              ON gl.group_id = g.id
             AND gl.latitude BETWEEN ? AND ?
             AND gl.longitude BETWEEN ? AND ?
             AND MBRContains(
                   ST_MakeEnvelope(ST_SRID(POINT(?, ?), 0), ST_SRID(POINT(?, ?), 0)),
                   gl.location
                 )
      WHERE g.archived_at IS NULL
        AND ${AUDIENCE_VISIBLE_SQL}${filters.sql}
        AND gl.location IS NOT NULL
        AND ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 0)) <= ?
      ORDER BY matched_interest DESC, distance_meters ASC, g.name ASC, g.id ASC
      LIMIT ? OFFSET ?`,
    [
      // Order matters: the placeholders are filled in the order they appear in the
      // SQL *text*, and `matched_interest` is the first one because it is in the
      // SELECT list, ahead of the distance expression.
      callerId, // SELECT: does the caller share the group's interest?
      origin.longitude, // SELECT: POINT(x = longitude)
      origin.latitude, // SELECT: POINT(y = latitude)
      callerId, // JOIN: the caller's own profile (eligibility)
      callerId, // JOIN: the caller's own membership
      box.minLatitude, // JOIN: numeric prefilter
      box.maxLatitude,
      box.minLongitude,
      box.maxLongitude,
      box.minLongitude, // JOIN: envelope corner 1
      box.minLatitude,
      box.maxLongitude, // JOIN: envelope corner 2
      box.maxLatitude,
      ...filters.values,
      origin.longitude, // WHERE: exact spherical distance
      origin.latitude,
      radiusMeters,
      page.limit + 1,
      page.offset,
    ],
  );

  return toGroupPage(rows, page);
}

// -----------------------------------------------------------------------------
// Creation, editing and archiving
// -----------------------------------------------------------------------------

interface NormalizedDraft {
  name: string;
  description: string;
  category: GroupCategoryId;
  visibility: GroupVisibility;
  audience: GroupAudience;
  locationLabel: string | null;
}

/**
 * Checks and normalises the text fields.
 *
 * Lengths are enforced here as well as by the column CHECK so the member gets a
 * sentence ("Group name must be 60 characters or fewer") instead of a constraint
 * name, and so an over-long value never reaches the database at all.
 */
function normalizeDraftFields(draft: {
  name: string;
  description: string;
  category: GroupCategoryId;
  visibility: GroupVisibility;
  audience: GroupAudience;
  locationLabel: string | null;
}): NormalizedDraft {
  const name = draft.name.trim();
  if (name.length < GROUP_NAME_MIN_LENGTH) {
    throw badRequest(`A group name needs at least ${GROUP_NAME_MIN_LENGTH} characters.`, { field: 'name' });
  }
  if (name.length > GROUP_NAME_MAX_LENGTH) {
    throw badRequest(`Group name must be ${GROUP_NAME_MAX_LENGTH} characters or fewer.`, { field: 'name' });
  }

  const description = draft.description.trim();
  if (description.length < 1) {
    throw badRequest('A short description is required so people know what the group is for.', {
      field: 'description',
    });
  }
  if (description.length > GROUP_DESCRIPTION_MAX_LENGTH) {
    throw badRequest(`The description must be ${GROUP_DESCRIPTION_MAX_LENGTH} characters or fewer.`, {
      field: 'description',
    });
  }

  const label = draft.locationLabel === null ? null : draft.locationLabel.trim();
  if (label !== null && label.length > 0) {
    // The rule itself lives in `domain/venue.ts` so the event form and this one can
    // never disagree about what a venue name is; an empty label is *not* refused
    // here, because a group without an anchor legitimately has none. Whether an
    // anchor may exist without a name is decided where the coordinates are.
    const problem = venueLabelProblem(label, GROUP_LOCATION_LABEL_MAX_LENGTH);
    if (problem !== null) throw badRequest(problem, { field: 'locationLabel' });
  }

  return {
    name,
    description,
    category: draft.category,
    visibility: draft.visibility,
    audience: draft.audience,
    locationLabel: label !== null && label.length > 0 ? label : null,
  };
}

/**
 * Checks a draft's interest against the catalogue, or normalises "none".
 *
 * `null`, `undefined` and an empty string all mean "no interest", which is a
 * legitimate answer - the column is nullable on purpose (migration 0010). Anything
 * else has to exist and still be active, because the column is a foreign key to
 * `interests`: refusing an unknown id here is what turns a database constraint into
 * a sentence the member can act on, exactly as `profileService` does when it saves
 * a member's own interests.
 */
async function resolveInterestId(interestId: string | null | undefined): Promise<string | null> {
  if (interestId === null || interestId === undefined) return null;

  const candidate = interestId.trim();
  if (candidate.length === 0) return null;

  const known = await activeInterestIds([candidate]);
  if (!known.has(candidate)) {
    throw badRequest('That interest is not in the catalogue. Pick one from the list.', {
      field: 'interestId',
    });
  }

  return candidate;
}

/**
 * Validates a coordinate pair and rounds it to the stored precision (~11 m).
 *
 * `null`/`null` means "no anchor", which is a legitimate answer. A half-supplied
 * pair, an out-of-range value or the exact (0, 0) reading (what a handset returns
 * when it has no fix) is refused, mirroring `locationService.setMyLocation`.
 */
function normalizeCoordinates(
  latitude: number | null,
  longitude: number | null,
): { latitude: number; longitude: number } | null {
  if (latitude === null && longitude === null) return null;

  if (latitude === null || longitude === null) {
    throw badRequest('A group location needs both a latitude and a longitude.', { field: 'location' });
  }
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    throw badRequest('Latitude must be between -90 and 90 and longitude between -180 and 180.', {
      field: 'location',
    });
  }
  if (latitude === 0 && longitude === 0) {
    throw badRequest(
      'That reading looks like a missing fix. Move somewhere with a clearer signal and try again.',
      { field: 'location' },
    );
  }

  return {
    latitude: roundCoordinate(latitude, COORDINATE_PRECISION_DECIMALS),
    longitude: roundCoordinate(longitude, COORDINATE_PRECISION_DECIMALS),
  };
}

/** Writes (or replaces) the group's geographic anchor. Longitude first, as always. */
async function writeGroupLocation(
  connection: PoolConnection,
  groupId: string,
  coordinates: { latitude: number; longitude: number },
): Promise<void> {
  await connection.query(
    `INSERT INTO group_locations (group_id, latitude, longitude, location, location_updated_at)
     VALUES (?, ?, ?, ST_SRID(POINT(?, ?), 0), NOW(3)) AS incoming
     ON DUPLICATE KEY UPDATE
       latitude = incoming.latitude,
       longitude = incoming.longitude,
       location = incoming.location,
       location_updated_at = NOW(3)`,
    [groupId, coordinates.latitude, coordinates.longitude, coordinates.longitude, coordinates.latitude],
  );
}

/**
 * Whether the group currently has a geographic anchor.
 *
 * Read on its own rather than added to `lockGroup`'s projection because it is the
 * only question that needs the `group_locations` row, and the answer decides
 * whether an edit that clears the label has to be refused (see `updateGroup`).
 */
async function hasGroupLocation(connection: PoolConnection, groupId: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT 1 FROM group_locations WHERE group_id = ? LIMIT 1',
    [groupId],
  );
  return rows.length > 0;
}

/**
 * Creates a group and establishes the caller as its owner - in one transaction.
 *
 * The group row and the owner membership row are written together on purpose: a
 * group with no owner would be unmanageable, and the schema's unique index on the
 * owner row means the two cannot drift apart even if this function were called
 * twice concurrently.
 *
 * The location argument is *not* copied from the creator's `user_locations` row -
 * it is whatever the client explicitly sent after the member tapped "use my
 * location" in the form. A group created without one simply has no anchor and never
 * appears in a nearby search.
 */
export async function createGroup(callerId: string, draft: GroupDraft): Promise<GroupSummary> {
  const fields = normalizeDraftFields(draft);
  const interestId = await resolveInterestId(draft.interestId);
  const coordinates = draft.removeLocation ? null : normalizeCoordinates(draft.latitude, draft.longitude);
  // A pin with no name is the one combination that leaves a group's location
  // unreadable, so it is refused here rather than stored: the check runs after
  // `normalizeCoordinates`, which means a half-supplied pair still gets its own,
  // more specific sentence.
  if (coordinates !== null && fields.locationLabel === null) {
    throw badRequest(VENUE_LABEL_REQUIRED_MESSAGE, { field: 'locationLabel' });
  }
  const groupId = newId();

  await withTransaction(async (connection) => {
    const eligibility = await readEligibility(connection, callerId);
    assertAudienceEligible(fields.audience, eligibility, 'create');

    await connection.query(
      `INSERT INTO \`groups\`
         (id, name, description, category, interest_id, visibility, audience, location_label, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        fields.name,
        fields.description,
        fields.category,
        interestId,
        fields.visibility,
        fields.audience,
        fields.locationLabel,
        callerId,
      ],
    );

    // `joined_at` is required by group_memberships_active_joined_chk for an active
    // row, and the owner's membership is active from the first instant.
    await connection.query(
      `INSERT INTO group_memberships (id, group_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'owner', 'active', NOW(3))`,
      [newId(), groupId, callerId],
    );

    if (coordinates) await writeGroupLocation(connection, groupId, coordinates);
  });

  return getGroup(callerId, groupId);
}

/** The fields an edit may change. Every one is optional; absent means "leave it". */
export interface GroupPatch {
  name?: string;
  description?: string;
  category?: GroupCategoryId;
  /** `null` clears the primary interest; omitted leaves it untouched. */
  interestId?: string | null;
  visibility?: GroupVisibility;
  audience?: GroupAudience;
  locationLabel?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  removeLocation?: boolean;
}

/**
 * Edits an owned group.
 *
 * Owner-only, deliberately: an administrator's powers are about *people* (requests
 * and members), not about what the group says about itself. Keeping the two apart
 * means a promoted admin can never quietly rename or re-scope someone else's group.
 *
 * The merged draft is validated as a whole, so a patch that only changes the
 * audience is checked against the group's existing name and description exactly as
 * a full edit would be. Changing the audience re-checks the *owner's* own
 * eligibility, because a member must not be able to lock themselves out of a group
 * they are responsible for.
 *
 * `interestId` follows the same "omitted means untouched" rule as every other
 * field, and an explicit `null` clears it: `undefined` and `null` therefore mean
 * different things here, which is why the column is read from the locked row rather
 * than defaulted.
 */
export async function updateGroup(
  callerId: string,
  groupId: string,
  patch: GroupPatch,
): Promise<GroupSummary> {
  const interestId = patch.interestId === undefined ? undefined : await resolveInterestId(patch.interestId);

  await withTransaction(async (connection) => {
    const current = await lockGroup(connection, groupId);

    const role = await activeRoleOf(connection, groupId, callerId);
    if (role !== 'owner') throw forbidden('Only the group owner can change its settings.');

    const fields = normalizeDraftFields({
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      category: (patch.category ?? current.category) as GroupCategoryId,
      visibility: (patch.visibility ?? current.visibility) as GroupVisibility,
      audience: (patch.audience ?? current.audience) as GroupAudience,
      locationLabel: patch.locationLabel === undefined ? current.location_label : patch.locationLabel,
    });

    if (fields.audience !== current.audience) {
      const eligibility = await readEligibility(connection, callerId);
      assertAudienceEligible(fields.audience, eligibility, 'create');
    }

    await connection.query(
      `UPDATE \`groups\`
          SET name = ?, description = ?, category = ?, interest_id = ?, visibility = ?, audience = ?, location_label = ?
        WHERE id = ?`,
      [
        fields.name,
        fields.description,
        fields.category,
        interestId === undefined ? current.interest_id : interestId,
        fields.visibility,
        fields.audience,
        fields.locationLabel,
        groupId,
      ],
    );

    const coordinates =
      patch.removeLocation === true
        ? null
        : patch.latitude === undefined && patch.longitude === undefined
          ? undefined
          : normalizeCoordinates(patch.latitude ?? null, patch.longitude ?? null);

    // The anchor this edit leaves behind: `undefined` means the patch did not touch
    // it, so the stored row answers, and `null` means "removed".
    const anchored = coordinates === undefined ? await hasGroupLocation(connection, groupId) : coordinates !== null;

    // A pin never outlives its name - including on an edit that only clears the
    // label, which would otherwise leave a coordinate pair with nothing to read.
    if (anchored && fields.locationLabel === null) {
      throw badRequest(VENUE_LABEL_REQUIRED_MESSAGE, { field: 'locationLabel' });
    }

    if (coordinates === null) {
      await connection.query('DELETE FROM group_locations WHERE group_id = ?', [groupId]);
    } else if (coordinates !== undefined) {
      await writeGroupLocation(connection, groupId, coordinates);
    }
  });

  return getGroup(callerId, groupId);
}

/**
 * Archives a group - the only "delete" this phase has.
 *
 * Nothing is removed: the memberships stay, so an administrator can still see who
 * was in it, and every listing, join and management action refuses an archived
 * group with `group_archived`. Owner-only, and idempotent in the sense that a
 * second call is refused with the same explanation rather than corrupting anything.
 */
export async function archiveGroup(callerId: string, groupId: string): Promise<void> {
  await withTransaction(async (connection) => {
    await lockGroup(connection, groupId);

    const role = await activeRoleOf(connection, groupId, callerId);
    if (role !== 'owner') throw forbidden('Only the group owner can archive it.');

    await connection.query('UPDATE `groups` SET archived_at = NOW(3) WHERE id = ?', [groupId]);
  });

  // The chat room closes with the group (Phase 7). Members keep the history - it is
  // still readable over HTTP - but nothing new can be said, so no socket should be
  // left waiting in a room that can no longer receive. Clients re-join and are
  // refused, which is what turns this into a visible "closed" state.
  evictGroupRoom(groupId);
}

// -----------------------------------------------------------------------------
// Joining, leaving and the request queue
// -----------------------------------------------------------------------------

/**
 * The documented re-entry rule, in one place.
 *
 * A decision made *about* a member - a declined request or a removal - is final:
 * repeating the join endpoint cannot undo it, which is what stops a removed member
 * from walking back into a private group by replaying a request. Only an owner or
 * administrator can change such a decision (and no endpoint re-opens it in this
 * phase; see the README's limitations).
 *
 * A *voluntary* exit is the opposite case: `left` may be re-requested at any time.
 */
function reEntryRefused(status: 'rejected' | 'removed'): AppError {
  return forbidden(
    status === 'removed'
      ? 'You were removed from this group, so you cannot rejoin it yourself. An owner or administrator can change that.'
      : 'Your request to join this group was declined, so it cannot be sent again. An owner or administrator can change that.',
  );
}

/**
 * Joins a public group outright, or requests access to a private one.
 *
 * The two outcomes are the whole difference between the visibilities, and they are
 * decided here from the *stored* visibility - never from the request:
 *
 *   * **public**  -> an active membership, immediately;
 *   * **private** -> a pending request, which an owner or administrator approves.
 *
 * The call is idempotent in both directions: an existing active membership or an
 * already-pending request is reported back unchanged rather than duplicated, so a
 * double tap cannot create a second row (and the schema's unique key on
 * `(group_id, user_id)` would refuse it anyway).
 *
 * There is no path where a client-supplied flag makes a request active.
 */
export async function joinGroup(callerId: string, groupId: string): Promise<GroupSummary> {
  await withTransaction(async (connection) => {
    const group = await lockGroup(connection, groupId);
    const eligibility = await readEligibility(connection, callerId);
    assertAudienceEligible(group.audience as GroupAudience, eligibility, 'join');

    const existing = await lockMembership(connection, groupId, callerId);

    if (existing && (existing.status === 'active' || existing.status === 'pending')) {
      return;
    }
    if (existing && (existing.status === 'rejected' || existing.status === 'removed')) {
      throw reEntryRefused(existing.status);
    }

    const activated = (group.visibility as GroupVisibility) === 'public';

    if (existing) {
      // A previously left membership becomes active (public) or pending (private).
      // `joined_at` is written only for an active row, to satisfy
      // group_memberships_active_joined_chk and to keep the history honest.
      await connection.query(
        activated
          ? `UPDATE group_memberships
                SET status = 'active', role = 'member', joined_at = NOW(3), decided_at = NULL, decided_by = NULL
              WHERE id = ?`
          : `UPDATE group_memberships
                SET status = 'pending', role = 'member', joined_at = NULL, decided_at = NULL, decided_by = NULL
              WHERE id = ?`,
        [existing.id],
      );
      return;
    }

    await connection.query(
      activated
        ? `INSERT INTO group_memberships (id, group_id, user_id, role, status, joined_at)
           VALUES (?, ?, ?, 'member', 'active', NOW(3))`
        : `INSERT INTO group_memberships (id, group_id, user_id, role, status)
           VALUES (?, ?, ?, 'member', 'pending')`,
      [newId(), groupId, callerId],
    );
  });

  return getGroup(callerId, groupId);
}

/**
 * Leaves a group, or withdraws a pending request.
 *
 * The owner is refused: a group with no owner would be unmanageable, and there is
 * no ownership transfer in this phase, so the owner's route out is to archive the
 * group. A member who is not in the group at all is a no-op rather than an error -
 * "leave" asks to end up outside, and they already are.
 */
export async function leaveGroup(callerId: string, groupId: string): Promise<GroupSummary> {
  await withTransaction(async (connection) => {
    await lockGroup(connection, groupId);

    const existing = await lockMembership(connection, groupId, callerId);
    if (!existing) return;

    if (existing.status === 'active' && existing.role === 'owner') {
      throw forbidden(
        'The owner cannot leave the group. Archive it instead, or hand ownership on once ownership transfer exists.',
      );
    }

    if (existing.status === 'active' || existing.status === 'pending') {
      await connection.query(
        `UPDATE group_memberships
            SET status = 'left', role = 'member', joined_at = ?, decided_at = NOW(3), decided_by = NULL
          WHERE id = ?`,
        [existing.joined_at, existing.id],
      );
    }
    // 'left' / 'rejected' / 'removed' rows are left untouched - there is nothing to
    // undo, and overwriting the decision would erase who made it.
  });

  // A member who has just left loses the chat immediately (Phase 7): their sockets
  // are pulled out of the group's room here, and every later read or send is refused
  // by `chatService` regardless of what their client still thinks it may do.
  evictUserFromGroup(groupId, callerId);

  return getGroup(callerId, groupId);
}

/**
 * Withdraws the caller's own pending request.
 *
 * A withdrawal is voluntary, so it lands on `left` - which means the member may
 * request again. That is the deliberate contrast with `rejected`: an administrator's
 * "no" is final, the member's own "not now" is not.
 */
export async function cancelJoinRequest(callerId: string, groupId: string): Promise<GroupSummary> {
  await withTransaction(async (connection) => {
    await lockGroup(connection, groupId);

    const existing = await lockMembership(connection, groupId, callerId);
    if (!existing || existing.status !== 'pending') {
      throw notFound('You do not have a pending request for this group.');
    }

    await connection.query(
      `UPDATE group_memberships
          SET status = 'left', role = 'member', joined_at = NULL, decided_at = NOW(3), decided_by = ?
        WHERE id = ?`,
      [callerId, existing.id],
    );
  });

  return getGroup(callerId, groupId);
}

// -----------------------------------------------------------------------------
// Managing members and requests
//
// Every entry point below re-checks the caller's *current* role against the
// database. None of them trusts a role, a status or an ownership flag from the
// request body, which is why a crafted `PATCH .../members/<self>` cannot promote
// anyone - including the caller.
// -----------------------------------------------------------------------------

interface MemberRow extends RowDataPacket {
  user_id: string;
  display_name: string;
  role: string;
  joined_at: Date | null;
  /** Present on the request queue query, where the interesting timestamp is `created_at`. */
  requested_at?: Date | null;
}

/** A decision that has just been recorded. */
export interface DecidedRequest {
  userId: string;
  displayName: string;
  status: MembershipStatus;
}

function mapMember(row: MemberRow): GroupMemberRecord {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role as MembershipRole,
    joinedAt: toIso(row.joined_at),
  };
}

/**
 * Reads a member's row for a response.
 *
 * Note what is missing: eligibility. A group administrator cannot learn another
 * member's `group_eligibility_gender` from any endpoint, because no query serving a
 * group ever selects it for anyone but the caller.
 */
async function readMember(
  connection: PoolConnection,
  groupId: string,
  userId: string,
): Promise<GroupMemberRecord> {
  const [rows] = await connection.query<MemberRow[]>(
    `SELECT m.user_id, u.display_name, m.role, m.joined_at
       FROM group_memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ? AND m.user_id = ? AND m.status = 'active'
      LIMIT 1`,
    [groupId, userId],
  );

  const row = rows[0];
  if (!row) throw notFound('That member is not in this group.');
  return mapMember(row);
}

/**
 * Requires an owner or administrator (or throws), after checking the group exists.
 *
 * Deliberately not "is a member": an ordinary member may read nothing here.
 */
async function requireManager(
  connection: PoolConnection,
  groupId: string,
  callerId: string,
): Promise<MembershipRole> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT id FROM `groups` WHERE id = ? LIMIT 1',
    [groupId],
  );
  if (!rows[0]) throw notFound('That group no longer exists.');

  const role = await activeRoleOf(connection, groupId, callerId);
  if (role !== 'owner' && role !== 'admin') {
    throw forbidden('Only an owner or administrator of this group can do that.');
  }
  return role;
}

/**
 * Requires an *active member* (any role) of the group, after checking it exists.
 *
 * Members read the member list; the request queue is stricter (see
 * `requireManager`). Non-members are refused either way, which is what keeps a
 * private group's membership out of reach of someone who is not in it.
 */
async function requireActiveMember(
  connection: PoolConnection,
  groupId: string,
  callerId: string,
): Promise<MembershipRole> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT id FROM `groups` WHERE id = ? LIMIT 1',
    [groupId],
  );
  if (!rows[0]) throw notFound('That group no longer exists.');

  const role = await activeRoleOf(connection, groupId, callerId);
  if (role === null) {
    throw forbidden('Only members of this group can see who else is in it.');
  }
  return role;
}

/**
 * The active member list.
 *
 * Readable by any active member; the request queue below is not. A plain
 * `memberCount` on a group summary is public because a count says nothing about
 * *who* - this endpoint says who, so a non-member never reaches it. No row here
 * carries `group_eligibility_gender`, so an administrator cannot inspect another
 * member's setting either.
 */
export async function listMembers(
  callerId: string,
  groupId: string,
  options: PageOptions,
): Promise<GroupMemberPage> {
  const page = clampPage(options.limit, MAX_MEMBERSHIP_PAGE_SIZE, options.offset);

  return withTransaction(async (connection) => {
    await requireActiveMember(connection, groupId, callerId);

    const [rows] = await connection.query<MemberRow[]>(
      `SELECT m.user_id, u.display_name, m.role, m.joined_at
         FROM group_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ? AND m.status = 'active'
        ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, u.display_name ASC, m.user_id ASC
        LIMIT ? OFFSET ?`,
      [groupId, page.limit + 1, page.offset],
    );

    const result = toRowPage(rows, page, page.limit);
    return {
      members: result.items.map(mapMember),
      offset: page.offset,
      hasMore: result.hasMore,
      nextOffset: result.nextOffset,
    };
  });
}

/**
 * The pending request queue, oldest first.
 *
 * "Oldest first" is deliberate: a queue nobody looks at should at least be fair, and
 * the request that has waited longest is the one its sender is most likely to have
 * given up on.
 */
export async function listJoinRequests(
  callerId: string,
  groupId: string,
  options: PageOptions,
): Promise<GroupRequestPage> {
  const page = clampPage(options.limit, MAX_MEMBERSHIP_PAGE_SIZE, options.offset);

  return withTransaction(async (connection) => {
    await requireManager(connection, groupId, callerId);

    const [rows] = await connection.query<MemberRow[]>(
      `SELECT m.user_id, u.display_name, m.role, m.created_at AS requested_at
         FROM group_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ? AND m.status = 'pending'
        ORDER BY m.created_at ASC, m.user_id ASC
        LIMIT ? OFFSET ?`,
      [groupId, page.limit + 1, page.offset],
    );

    const result = toRowPage(rows, page, page.limit);
    return {
      requests: result.items.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        requestedAt: toIso(row.requested_at ?? null),
      })),
      offset: page.offset,
      hasMore: result.hasMore,
      nextOffset: result.nextOffset,
    };
  });
}

/**
 * Approves a pending request.
 *
 * Eligibility is re-checked here as well as at request time, because a member's own
 * setting can change in between: approving a request that no longer qualifies would
 * quietly bypass the audience rule.
 */
export async function approveJoinRequest(
  callerId: string,
  groupId: string,
  targetUserId: string,
): Promise<DecidedRequest> {
  return withTransaction(async (connection) => {
    const group = await lockGroup(connection, groupId);
    await requireManager(connection, groupId, callerId);

    const target = await lockMembership(connection, groupId, targetUserId);
    if (!target || target.status !== 'pending') {
      throw notFound('That member does not have a pending request for this group.');
    }

    const eligibility = await readEligibility(connection, targetUserId);
    assertAudienceEligible(group.audience as GroupAudience, eligibility, 'approve');

    await connection.query(
      `UPDATE group_memberships
          SET status = 'active', role = 'member', joined_at = NOW(3), decided_at = NOW(3), decided_by = ?
        WHERE id = ?`,
      [callerId, target.id],
    );

    const member = await readMember(connection, groupId, targetUserId);
    return { userId: member.userId, displayName: member.displayName, status: 'active' };
  });
}

/** Declines a pending request. No active membership is created, ever. */
export async function rejectJoinRequest(
  callerId: string,
  groupId: string,
  targetUserId: string,
): Promise<DecidedRequest> {
  return withTransaction(async (connection) => {
    await lockGroup(connection, groupId);
    await requireManager(connection, groupId, callerId);

    const target = await lockMembership(connection, groupId, targetUserId);
    if (!target || target.status !== 'pending') {
      throw notFound('That member does not have a pending request for this group.');
    }

    await connection.query(
      `UPDATE group_memberships
          SET status = 'rejected', role = 'member', joined_at = NULL, decided_at = NOW(3), decided_by = ?
        WHERE id = ?`,
      [callerId, target.id],
    );

    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT display_name FROM users WHERE id = ? LIMIT 1',
      [targetUserId],
    );

    return {
      userId: targetUserId,
      displayName: String(rows[0]?.display_name ?? 'Member'),
      status: 'rejected',
    };
  });
}

/**
 * Promotes a member to administrator, or returns an administrator to a member.
 *
 * Owner-only, and the two ways an administrator could escalate are both closed here
 * rather than in the UI:
 *
 *   * `owner` is not an accepted value - there is no ownership transfer in this
 *     phase, so nobody can promote themselves or anyone else to owner;
 *   * an administrator cannot call this at all, so they cannot promote a peer (or
 *     themselves) and then act with wider powers.
 *
 * The owner's own row is refused as a target in both directions, which keeps the
 * "exactly one owner" rule true without relying on the caller's good manners.
 */
export async function setMemberRole(
  callerId: string,
  groupId: string,
  targetUserId: string,
  role: 'admin' | 'member',
): Promise<GroupMemberRecord> {
  return withTransaction(async (connection) => {
    await lockGroup(connection, groupId);

    const callerRole = await activeRoleOf(connection, groupId, callerId);
    if (callerRole !== 'owner') {
      throw forbidden('Only the group owner can change member roles.');
    }

    const target = await lockMembership(connection, groupId, targetUserId);
    if (!target || target.status !== 'active') {
      throw notFound('That member is not in this group.');
    }
    if (target.role === 'owner') {
      throw forbidden('The owner\'s role cannot be changed. Ownership transfer is not available.');
    }

    await connection.query('UPDATE group_memberships SET role = ? WHERE id = ?', [role, target.id]);
    return readMember(connection, groupId, targetUserId);
  });
}

/**
 * Removes a member.
 *
 * The authorization ladder, enforced here and not in the UI:
 *
 *   * an owner may remove a member or an administrator;
 *   * an administrator may remove an ordinary member only - never a peer, and never
 *     the owner;
 *   * nobody may remove themselves this way (`leave` is the button for that), so an
 *     administrator cannot use removal to sidestep the owner's controls.
 *
 * Removal is recorded as `removed`, which is terminal: repeating the join endpoint
 * afterwards is refused by `reEntryRefused`, and the row keeps the original
 * `joined_at` so the group's history stays readable.
 */
export async function removeMember(
  callerId: string,
  groupId: string,
  targetUserId: string,
): Promise<void> {
  await withTransaction(async (connection) => {
    await lockGroup(connection, groupId);

    const callerRole = await activeRoleOf(connection, groupId, callerId);
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      throw forbidden('Only an owner or administrator of this group can remove a member.');
    }

    if (targetUserId === callerId) {
      throw forbidden('Use "leave group" to remove yourself.');
    }

    const target = await lockMembership(connection, groupId, targetUserId);
    if (!target) throw notFound('That member is not in this group.');
    // Removing an already-removed member is a no-op, so a retried request after a
    // dropped response cannot turn into an error the member cannot act on.
    if (target.status === 'removed') return;
    if (target.status !== 'active') {
      throw notFound('That member is not in this group.');
    }

    if (target.role === 'owner') {
      throw forbidden('The owner cannot be removed. Archive the group instead.');
    }
    if (callerRole === 'admin' && target.role === 'admin') {
      throw forbidden('An administrator cannot remove another administrator.');
    }

    await connection.query(
      `UPDATE group_memberships
          SET status = 'removed', role = 'member', decided_at = NOW(3), decided_by = ?
        WHERE id = ?`,
      [callerId, target.id],
    );
  });

  // Removal takes the member's chat access away at the same moment their membership
  // ends (Phase 7). Their sockets leave the room, their history requests and sends
  // are refused, and the messages they wrote stay in the group.
  evictUserFromGroup(groupId, targetUserId);
}

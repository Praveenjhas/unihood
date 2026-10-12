/**
 * Events, RSVPs and the rules that hold them together.
 *
 * This is the only module that knows the shape of `events`, `event_locations` and
 * `event_rsvps`, and it holds every authorization rule for the phase. The rules
 * live here rather than in the route layer because the routes are just the HTTP
 * surface: a rule enforced here is enforced for every caller, including a
 * hand-written request that never went near the mobile app.
 *
 * The five properties worth stating up front, because the SQL below is written to
 * preserve them:
 *
 *   1. **Identity comes from the token.** No function takes a user id from a body
 *      or a query string; the caller's id is always an argument supplied by
 *      `requireAuth`.
 *   2. **An event inherits its group's access rules.** There is no `visibility`
 *      column on `events`. A group event is visible to whoever may see the group
 *      under the Phase 3 rules - audience eligibility for a public group, active
 *      membership for a private one - and a *pending*, *rejected*, *left* or
 *      *removed* membership grants nothing. A guessed event id cannot bypass that:
 *      the visibility predicate is part of the `WHERE` clause of the read, so a
 *      private event is a 404, indistinguishable from an id that does not exist.
 *   3. **Membership and eligibility are re-read on every request**, inside the
 *      same transaction as any write. Nothing about the viewer's role, the
 *      audience or the participant count is trusted from the request.
 *   4. **Nothing is deleted.** Cancelling writes `status = 'cancelled'` and
 *      `cancelled_at`; an RSVP moves between `going` and `cancelled`. The rows
 *      stay, so attendance history survives - and because every read re-checks
 *      access, a former member's retained row is invisible to them.
 *   5. **Capacity is decided under a lock.** Every RSVP takes a `FOR UPDATE` lock
 *      on the event row first, so two simultaneous requests for the last place are
 *      serialised by the database rather than by hope.
 *
 * `groups` is a reserved word in MySQL 8, so that table is written as
 * `` `groups` `` in every statement here - see the header of
 * `migrations/0006_groups.sql`.
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
  EVENT_DESCRIPTION_MAX_LENGTH,
  EVENT_LOCATION_LABEL_MAX_LENGTH,
  EVENT_MAX_DURATION_DAYS,
  EVENT_TITLE_MAX_LENGTH,
  EVENT_TITLE_MIN_LENGTH,
  MAX_ATTENDEE_PAGE_SIZE,
  MAX_EVENT_PAGE_SIZE,
  MAX_EVENT_PARTICIPANTS,
  isSaneEventWindow,
  type EventCategoryId,
  type EventFeedFilter,
  type EventStatus,
  type RsvpAnswer,
  type RsvpStatus,
} from '../domain/events';
import {
  isEligibleForAudience,
  type GroupAudience,
  type GroupEligibility,
  type GroupVisibility,
  type MembershipRole,
} from '../domain/groups';
import { VENUE_LABEL_REQUIRED_MESSAGE, venueLabelProblem } from '../domain/venue';
import { toIso } from '../lib/dates';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/tokens';
import { activeRoleOf, readEligibility } from './groupService';
import { findStoredLocation } from './locationService';

// -----------------------------------------------------------------------------
// The public shape of an event
// -----------------------------------------------------------------------------

/**
 * One event as the API describes it.
 *
 * The same shape comes back from every listing, from the detail endpoint and from
 * every mutation, so the mobile client has exactly one event type to render. The
 * conditional fields are deliberate:
 *
 *   * `distanceMeters` is present only on a nearby search, is rounded to 50 m and
 *     is `null` for an event with no geographic anchor - so an unlocated event is
 *     never presented as confirmed within 5 km.
 *   * `groupName` / `groupVisibility` / `groupAudience` are `null` for a
 *     standalone event. They are the *group's* own public facts, and they only
 *     appear on an event the viewer was already allowed to read.
 *   * `viewerCanManage` is the server's own answer to "may I edit or cancel
 *     this?", computed from the stored creator and group roles. The client shows
 *     or hides controls from it, and the write endpoints re-derive it.
 */
export interface EventSummary {
  id: string;
  title: string;
  description: string;
  category: EventCategoryId;
  /** ISO 8601 UTC (`...Z`); the client renders it in the device's timezone. */
  startAt: string | null;
  endAt: string | null;
  locationLabel: string | null;
  hasLocation: boolean;
  distanceMeters: number | null;
  groupId: string | null;
  groupName: string | null;
  groupVisibility: GroupVisibility | null;
  groupAudience: GroupAudience | null;
  groupArchived: boolean;
  creatorId: string;
  creatorName: string;
  maxParticipants: number | null;
  goingCount: number;
  /** `null` when the event has no capacity limit. Never negative. */
  spotsLeft: number | null;
  isFull: boolean;
  status: EventStatus;
  cancelledAt: string | null;
  /** True once the end time has passed, whether or not it was cancelled. */
  isPast: boolean;
  viewerRsvpStatus: RsvpStatus | null;
  viewerIsGoing: boolean;
  viewerIsCreator: boolean;
  viewerCanManage: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface EventPage {
  events: EventSummary[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** One attendee, for the guest list. Never carries an email or a coordinate. */
export interface EventAttendeeRecord {
  userId: string;
  displayName: string;
  isYou: boolean;
  rsvpedAt: string | null;
}

export interface EventAttendeePage {
  attendees: EventAttendeeRecord[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** The writable half of an event, as the create and edit forms send it. */
export interface EventDraft {
  title: string;
  description: string;
  category: EventCategoryId;
  /** ISO 8601 with an offset (`2026-10-10T18:00:00.000Z`). Stored as UTC. */
  startAt: string;
  endAt: string;
  locationLabel: string | null;
  /** Both or neither; `null` on create means "no geographic anchor". */
  latitude: number | null;
  longitude: number | null;
  /** Explicitly removes the stored anchor on an edit. */
  removeLocation: boolean;
  /** `null` for a standalone event. Never accepted from the client on an edit. */
  groupId: string | null;
  /** `null` means "no capacity limit". */
  maxParticipants: number | null;
}

/** The fields an edit may change. Every one is optional; absent means "leave it". */
export interface EventPatch {
  title?: string;
  description?: string;
  category?: EventCategoryId;
  startAt?: string;
  endAt?: string;
  locationLabel?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  removeLocation?: boolean;
  maxParticipants?: number | null;
}

export interface ListEventsOptions {
  query: string;
  /** Selected category chips; an empty list means "every category". */
  categories: readonly EventCategoryId[];
  /** Restricts the listing to one group's own events. */
  groupId: string | null;
  limit: number;
  offset: number;
}

export interface ListNearbyEventsOptions extends ListEventsOptions {
  radiusMeters: number;
}

export interface PageOptions {
  limit: number;
  offset: number;
}

// -----------------------------------------------------------------------------
// The projection every read is built from
// -----------------------------------------------------------------------------

interface EventRow extends RowDataPacket {
  id: string;
  title: string;
  description: string;
  category: string;
  start_at: Date | null;
  end_at: Date | null;
  location_label: string | null;
  created_by: string;
  group_id: string | null;
  max_participants: number | string | null;
  status: string;
  cancelled_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  creator_display_name: string | null;
  group_name: string | null;
  group_visibility: string | null;
  group_audience: string | null;
  group_archived_at: Date | null;
  has_location: number;
  viewer_eligibility: string | null;
  viewer_group_role: string | null;
  viewer_group_status: string | null;
  viewer_rsvp_status: string | null;
  going_count: number | string;
  distance_meters?: number | string | null;
}

/**
 * The columns every event response needs.
 *
 * The going count is a correlated subquery rather than an aggregate join, for the
 * same reason the group counts are: `event_rsvps_event_status_idx` covers
 * `(event_id, status)`, a page is at most 50 rows, and an aggregate would need a
 * GROUP BY over the whole RSVP table to count one event's guests.
 *
 * `viewer_*` and `viewer_eligibility` come from joins bound to the *caller's* id,
 * so the viewer's membership state and self-declared eligibility are read from the
 * database on every request instead of being trusted from the request.
 */
const EVENT_COLUMNS = `
  e.id,
  e.title,
  e.description,
  e.category,
  e.start_at,
  e.end_at,
  e.location_label,
  e.created_by,
  e.group_id,
  e.max_participants,
  e.status,
  e.cancelled_at,
  e.created_at,
  e.updated_at,
  creator.display_name AS creator_display_name,
  g.name AS group_name,
  g.visibility AS group_visibility,
  g.audience AS group_audience,
  g.archived_at AS group_archived_at,
  (el.event_id IS NOT NULL) AS has_location,
  me.group_eligibility_gender AS viewer_eligibility,
  viewer.role AS viewer_group_role,
  viewer.status AS viewer_group_status,
  mine.status AS viewer_rsvp_status,
  (SELECT COUNT(*) FROM event_rsvps counted
    WHERE counted.event_id = e.id AND counted.status = 'going') AS going_count
`;

/**
 * The joins every read shares: the creator's display name, the caller's own
 * profile row (where eligibility comes from), the caller's own RSVP row and the
 * caller's own membership of the hosting group.
 *
 * Three bound parameters, in this order: the caller for `me`, the caller for
 * `mine`, the caller for `viewer`.
 */
const EVENT_JOINS = `
  JOIN users creator ON creator.id = e.created_by
  JOIN profiles me ON me.user_id = ?
  LEFT JOIN \`groups\` g ON g.id = e.group_id
  LEFT JOIN event_rsvps mine ON mine.event_id = e.id AND mine.user_id = ?
  LEFT JOIN group_memberships viewer ON viewer.group_id = e.group_id AND viewer.user_id = ?
`;

/** The location join. A nearby query continues this `ON` clause with its box. */
const LOCATION_LEFT_JOIN = `
  LEFT JOIN event_locations el ON el.event_id = e.id
`;

/**
 * Whether the caller may read this event at all.
 *
 * Three cases, in the order the SQL writes them:
 *
 *   1. a **standalone** event is readable by any authenticated member;
 *   2. an **active member** (or owner/administrator) of the hosting group is
 *      always allowed - membership is the grant, and it is what keeps a private
 *      group's events readable after the group is archived;
 *   3. anyone else may read a **public** group's event only while the group is not
 *      archived and the group's audience accepts them. A missing eligibility value
 *      fails a restricted audience on purpose: the member has told us nothing, so
 *      the server cannot assert that they qualify.
 *
 * A pending, rejected, left or removed membership matches none of these, so a
 * private group's event is invisible - and indistinguishable from an unknown id.
 */
const EVENT_VISIBLE_SQL = `(
    e.group_id IS NULL
    OR viewer.status = 'active'
    OR (
      g.visibility = 'public'
      AND g.archived_at IS NULL
      AND (
        g.audience = 'everyone'
        OR (g.audience = 'men_only' AND me.group_eligibility_gender = 'man')
        OR (g.audience = 'women_only' AND me.group_eligibility_gender = 'woman')
      )
    )
  )`;

/**
 * "Upcoming": not cancelled and not finished.
 *
 * `end_at > NOW(3)` rather than `start_at` - an event that is under way is still
 * something a member can turn up to. Cancelled events are excluded here rather
 * than only in the listing, so every upcoming view agrees, and a cancelled RSVP
 * therefore stops counting as active attendance in Going.
 */
const EVENT_UPCOMING_SQL = `(e.status = 'scheduled' AND e.end_at > NOW(3))`;

/** An archived group's events stay readable by its members, but out of discovery. */
const EVENT_OPEN_GROUP_SQL = `(e.group_id IS NULL OR g.archived_at IS NULL)`;

/** A COUNT (which mysql2 may hand back as a string) or a DECIMAL -> a number. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapEvent(row: EventRow, callerId: string): EventSummary {
  const groupId = row.group_id;
  const hasGroup = groupId !== null;
  const isActiveMember = hasGroup && row.viewer_group_status === 'active';
  const role = isActiveMember ? (row.viewer_group_role as MembershipRole) : null;
  const isCreator = row.created_by === callerId;

  // The creator keeps the controls only while they are still entitled to them: a
  // standalone event is theirs outright, and a group event belongs to whoever
  // currently runs the group once they are no longer in it.
  const managesGroup = role === 'owner' || role === 'admin';
  const canManage = managesGroup || (isCreator && (!hasGroup || isActiveMember));

  const goingCount = Number(row.going_count ?? 0);
  const maxParticipants = toNumberOrNull(row.max_participants);
  const isFull = maxParticipants !== null && goingCount >= maxParticipants;
  const endAt = row.end_at;

  const rsvpStatus = (row.viewer_rsvp_status as RsvpStatus | null) ?? null;
  const distance = toNumberOrNull(row.distance_meters);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category as EventCategoryId,
    startAt: toIso(row.start_at),
    endAt: toIso(row.end_at),
    locationLabel: row.location_label,
    hasLocation: row.has_location === 1,
    distanceMeters: distance === null ? null : roundDistance(distance),
    groupId,
    groupName: hasGroup ? row.group_name : null,
    groupVisibility: hasGroup ? (row.group_visibility as GroupVisibility) : null,
    groupAudience: hasGroup ? (row.group_audience as GroupAudience) : null,
    groupArchived: hasGroup && row.group_archived_at !== null,
    creatorId: row.created_by,
    creatorName: row.creator_display_name ?? 'A member',
    maxParticipants,
    goingCount,
    spotsLeft: maxParticipants === null ? null : Math.max(0, maxParticipants - goingCount),
    isFull,
    status: row.status as EventStatus,
    cancelledAt: toIso(row.cancelled_at),
    isPast: endAt !== null && endAt.getTime() <= Date.now(),
    viewerRsvpStatus: rsvpStatus,
    viewerIsGoing: rsvpStatus === 'going',
    viewerIsCreator: isCreator,
    viewerCanManage: canManage,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Escapes the LIKE metacharacters in a search term.
 *
 * Without this a search for `%` would match every event and `_` would match any
 * single character - surprising, and a cheap way for a client to ask the database
 * for more work than it meant to.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The shared `q` / category filter, as SQL plus bound values. */
function buildListFilters(options: ListEventsOptions): { sql: string; values: unknown[] } {
  let sql = '';
  const values: unknown[] = [];

  const query = options.query.trim();
  if (query.length > 0) {
    const like = `%${escapeLike(query)}%`;
    sql += ' AND (e.title LIKE ? OR e.description LIKE ? OR e.location_label LIKE ?)';
    values.push(like, like, like);
  }

  if (options.categories.length > 0) {
    // Placeholders are generated, but the *values* are always bound - the same
    // technique `groupService` and `interestService` use for an IN list.
    const placeholders = options.categories.map(() => '?').join(', ');
    sql += ` AND e.category IN (${placeholders})`;
    values.push(...options.categories);
  }

  return { sql, values };
}

/**
 * Turns `limit + 1` rows into a page.
 *
 * One extra row is fetched so `hasMore` is a fact rather than a guess - otherwise
 * a full page that happens to be the last one produces a "load more" affordance
 * that returns nothing.
 */
function toEventPage(rows: EventRow[], options: PageOptions, callerId: string): EventPage {
  const hasMore = rows.length > options.limit;
  const visible = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    events: visible.map((row) => mapEvent(row, callerId)),
    offset: options.offset,
    hasMore,
    nextOffset: hasMore ? options.offset + visible.length : null,
  };
}

/** Bounded paging, so one request cannot ask for the whole table. */
function clampPage(limit: number, max: number, offset: number): PageOptions {
  return {
    limit: Math.min(Math.max(Math.trunc(limit) || 1, 1), max),
    offset: Math.max(Math.trunc(offset) || 0, 0),
  };
}

// -----------------------------------------------------------------------------
// Discovery reads
// -----------------------------------------------------------------------------

/**
 * One event, for the detail screen.
 *
 * The visibility predicate is part of the query, so a private group's event is a
 * 404 for a non-member - the same answer as an id that never existed, which is
 * what stops the endpoint being used to test whether an event is real. A cancelled
 * or already-finished event is still returned to someone who may see it: the page
 * has to be able to say "this was cancelled" rather than pretend it never was.
 */
export async function getEvent(callerId: string, eventId: string): Promise<EventSummary> {
  const [rows] = await pool.query<EventRow[]>(
    `SELECT ${EVENT_COLUMNS}
       FROM events e
       ${EVENT_JOINS}
       ${LOCATION_LEFT_JOIN}
      WHERE e.id = ?
        AND ${EVENT_VISIBLE_SQL}
      LIMIT 1`,
    [callerId, callerId, callerId, eventId],
  );

  const row = rows[0];
  if (!row) {
    throw notFound('That event could not be found. It may have been cancelled, or it may not be shared with you.');
  }

  return mapEvent(row, callerId);
}

/**
 * Upcoming events the caller may read, in time order.
 *
 * This is the non-geographic listing: it includes standalone events and events
 * from groups the caller may see (public groups accepted by their audience, and
 * private groups they are an active member of), whether or not those events have
 * coordinates. An unlocated event therefore appears here and *not* in a nearby
 * search, which is exactly the distinction the product asks for.
 *
 * `groupId` narrows it to one group's own events, which is what the group detail
 * screen uses - and a non-member of a private group simply gets an empty list,
 * because the visibility predicate filters the rows rather than being relaxed by
 * the group filter.
 */
export async function listEvents(callerId: string, options: ListEventsOptions): Promise<EventPage> {
  const page = clampPage(options.limit, MAX_EVENT_PAGE_SIZE, options.offset);
  const filters = buildListFilters(options);
  const groupSql = options.groupId === null ? '' : ' AND e.group_id = ?';
  const groupValues = options.groupId === null ? [] : [options.groupId];

  const [rows] = await pool.query<EventRow[]>(
    `SELECT ${EVENT_COLUMNS}
       FROM events e
       ${EVENT_JOINS}
       ${LOCATION_LEFT_JOIN}
      WHERE ${EVENT_VISIBLE_SQL}
        AND ${EVENT_UPCOMING_SQL}
        AND ${EVENT_OPEN_GROUP_SQL}${groupSql}${filters.sql}
      ORDER BY e.start_at ASC, e.id ASC
      LIMIT ? OFFSET ?`,
    [callerId, callerId, callerId, ...groupValues, ...filters.values, page.limit + 1, page.offset],
  );

  return toEventPage(rows, page, callerId);
}

/**
 * Nearby events, filtered by the database rather than by the client.
 *
 * This is migration 0003's spatial design applied to `event_locations`, and it is
 * worth reading alongside the group version:
 *
 *   * `ST_Distance_Sphere(el.location, ST_SRID(POINT(?, ?), 0))` - **longitude
 *     first**, because that is the axis ordering this server was measured with.
 *     Getting the pair the wrong way round silently produces distances that are
 *     wrong by thousands of kilometres.
 *   * the bounding box (`MBRContains` over `ST_MakeEnvelope`) is the index-using
 *     prefilter; the exact spherical test runs afterwards and discards the box's
 *     corners. The radius is bound in metres, and the origin is the caller's *own*
 *     stored fix - never a request field.
 *   * an event with no `event_locations` row cannot match: the geographic
 *     conditions live in the `LEFT JOIN ... ON`, and `el.location IS NOT NULL` is
 *     required, so an unlocated event is never presented as confirmed nearby.
 *   * cancelled and finished events are excluded, and a private group's events are
 *     filtered out for anyone who is not an active member.
 *   * the distance column is rounded to 50 m before it leaves `mapEvent`.
 */
export async function listNearbyEvents(callerId: string, options: ListNearbyEventsOptions): Promise<EventPage> {
  const page = clampPage(options.limit, MAX_EVENT_PAGE_SIZE, options.offset);
  const radiusMeters = clampRadiusMeters(options.radiusMeters);

  const origin = await findStoredLocation(callerId);
  if (!origin) {
    throw new AppError(
      'location_required',
      409,
      'Set your nearby area in your profile before searching nearby events. It is saved until you change it.',
    );
  }

  const box = boundingBox(origin.latitude, origin.longitude, radiusMeters);
  const filters = buildListFilters(options);

  const [rows] = await pool.query<EventRow[]>(
    `SELECT ${EVENT_COLUMNS},
            ST_Distance_Sphere(el.location, ST_SRID(POINT(?, ?), 0)) AS distance_meters
       FROM events e
       ${EVENT_JOINS}
       ${LOCATION_LEFT_JOIN}
         AND el.latitude BETWEEN ? AND ?
         AND el.longitude BETWEEN ? AND ?
         AND MBRContains(
               ST_MakeEnvelope(ST_SRID(POINT(?, ?), 0), ST_SRID(POINT(?, ?), 0)),
               el.location
             )
      WHERE ${EVENT_VISIBLE_SQL}
        AND ${EVENT_UPCOMING_SQL}
        AND ${EVENT_OPEN_GROUP_SQL}${filters.sql}
        AND el.location IS NOT NULL
        AND ST_Distance_Sphere(el.location, ST_SRID(POINT(?, ?), 0)) <= ?
      ORDER BY distance_meters ASC, e.start_at ASC, e.id ASC
      LIMIT ? OFFSET ?`,
    [
      origin.longitude, // SELECT: POINT(x = longitude)
      origin.latitude, // SELECT: POINT(y = latitude)
      callerId, // JOIN: the caller's own profile (eligibility)
      callerId, // JOIN: the caller's own RSVP row
      callerId, // JOIN: the caller's own group membership
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

  return toEventPage(rows, page, callerId);
}

/**
 * Upcoming events belonging to the groups the caller is an *active* member of.
 *
 * No coordinates are required: this is the answer for a member who has denied the
 * OS location permission or switched nearby discovery off, and it is deliberately
 * not distance-filtered - "the groups you are in", not "the groups near you". An
 * archived group's events are excluded, as are cancelled and finished events; a
 * pending, rejected, left or removed membership matches no row here.
 */
export async function listMyGroupEvents(callerId: string, options: PageOptions): Promise<EventPage> {
  const page = clampPage(options.limit, MAX_EVENT_PAGE_SIZE, options.offset);

  const [rows] = await pool.query<EventRow[]>(
    `SELECT ${EVENT_COLUMNS}
       FROM events e
       ${EVENT_JOINS}
       ${LOCATION_LEFT_JOIN}
       JOIN group_memberships mine_group
         ON mine_group.group_id = e.group_id
        AND mine_group.user_id = ?
        AND mine_group.status = 'active'
      WHERE e.group_id IS NOT NULL
        AND g.archived_at IS NULL
        AND ${EVENT_UPCOMING_SQL}
      ORDER BY e.start_at ASC, e.id ASC
      LIMIT ? OFFSET ?`,
    [callerId, callerId, callerId, callerId, page.limit + 1, page.offset],
  );

  return toEventPage(rows, page, callerId);
}

/**
 * Upcoming events the caller has actively said yes to.
 *
 * The join is on `event_rsvps.status = 'going'`, so a cancelled RSVP drops out
 * immediately, and `${EVENT_UPCOMING_SQL}` removes an event that was cancelled by
 * its organiser - which is the documented behaviour: a cancelled event's remaining
 * attendance stops counting as active attendance in Going, while the row itself
 * survives for the record.
 *
 * `${EVENT_VISIBLE_SQL}` is applied here too. That is what stops a former member of
 * a private group from still seeing that group's event through their own Going
 * list - the balance between "history is kept" and "an RSVP is not a key".
 */
export async function listGoingEvents(callerId: string, options: PageOptions): Promise<EventPage> {
  const page = clampPage(options.limit, MAX_EVENT_PAGE_SIZE, options.offset);

  const [rows] = await pool.query<EventRow[]>(
    `SELECT ${EVENT_COLUMNS}
       FROM events e
       ${EVENT_JOINS}
       ${LOCATION_LEFT_JOIN}
       JOIN event_rsvps mine_rsvp
         ON mine_rsvp.event_id = e.id
        AND mine_rsvp.user_id = ?
        AND mine_rsvp.status = 'going'
      WHERE ${EVENT_VISIBLE_SQL}
        AND ${EVENT_UPCOMING_SQL}
        AND ${EVENT_OPEN_GROUP_SQL}
      ORDER BY e.start_at ASC, e.id ASC
      LIMIT ? OFFSET ?`,
    [callerId, callerId, callerId, callerId, page.limit + 1, page.offset],
  );

  return toEventPage(rows, page, callerId);
}

/**
 * The response-state predicate for each unified-feed filter.
 *
 * They are written as SQL fragments rather than as four queries because the list is
 * the *same* list: only the member's own `event_rsvps` row changes the answer, so
 * "Going" and "Not going" can never disagree about which event they are describing.
 *
 * The three interesting cases, and why each is what it is:
 *
 *   * `needs_response` - no row, or a row the member *withdrew* (`cancelled`).
 *     A withdrawal puts a member back to "not answered", which is exactly the state
 *     the filter is named after; `not_going` is deliberately **not** included,
 *     because declining is an answer.
 *   * `going` / `not_going` - the stored status, and nothing else. Neither counts
 *     towards capacity (only `going` does, and that is decided in `event_rsvps`).
 */
const FEED_RESPONSE_SQL: Record<EventFeedFilter, string> = {
  upcoming: '',
  needs_response: "AND (mine.status IS NULL OR mine.status = 'cancelled')",
  going: "AND mine.status = 'going'",
  not_going: "AND mine.status = 'not_going'",
};

/**
 * The unified upcoming feed for the Events tab (Phase 7).
 *
 * One list, four filters, and a hard boundary: an event appears only when it is
 * **scheduled and not yet ended**, it is attached to a group the caller is an
 * **active** member of, and that group is not archived. That is narrower than
 * `listEvents` on purpose:
 *
 *   * a **private** group's event is visible only to its members, so guessing an id
 *     cannot reach it;
 *   * a pending request is not a membership, so the feed does not leak a private
 *     group's calendar to someone who has merely asked to join;
 *   * a **standalone** (legacy) event is not in this feed at all. Standalone events
 *     created before Phase 7 remain readable through `GET /api/events/:id` and the
 *     other listings, and their rows are untouched - they simply are not part of
 *     "what my groups have on". New events are created against an active group
 *     (`POST /api/events` still accepts a standalone body for compatibility, and
 *     that event is then reachable by id rather than by this feed).
 *
 * `EVENT_UPCOMING_SQL` is what removes cancelled and finished events, so a cancelled
 * group event leaves the feed - and the group's own upcoming section - without the
 * row being deleted.
 */
export async function listGroupEventFeed(
  callerId: string,
  options: ListEventsOptions & { response: EventFeedFilter },
): Promise<EventPage> {
  const page = clampPage(options.limit, MAX_EVENT_PAGE_SIZE, options.offset);
  const filters = buildListFilters(options);

  const [rows] = await pool.query<EventRow[]>(
    `SELECT ${EVENT_COLUMNS}
       FROM events e
       ${EVENT_JOINS}
       ${LOCATION_LEFT_JOIN}
       JOIN group_memberships mine_group
         ON mine_group.group_id = e.group_id
        AND mine_group.user_id = ?
        AND mine_group.status = 'active'
      WHERE e.group_id IS NOT NULL
        AND g.archived_at IS NULL
        AND ${EVENT_UPCOMING_SQL}
        ${FEED_RESPONSE_SQL[options.response]}${filters.sql}
      ORDER BY e.start_at ASC, e.id ASC
      LIMIT ? OFFSET ?`,
    [callerId, callerId, callerId, callerId, ...filters.values, page.limit + 1, page.offset],
  );

  return toEventPage(rows, page, callerId);
}

/**
 * The guest list for one event.
 *
 * Readable by anyone who may read the event - which is what keeps a private
 * group's attendee list behind the same membership check as the event itself, so a
 * non-member can never learn who is going to it. Every row carries a display name
 * and nothing else: no email, no coordinate, and `isYou` so the member can find
 * themselves without the client having to know its own id twice.
 */
export async function listEventAttendees(
  callerId: string,
  eventId: string,
  options: PageOptions,
): Promise<EventAttendeePage> {
  const page = clampPage(options.limit, MAX_ATTENDEE_PAGE_SIZE, options.offset);

  const [visible] = await pool.query<RowDataPacket[]>(
    `SELECT e.id
       FROM events e
       ${EVENT_JOINS}
      WHERE e.id = ?
        AND ${EVENT_VISIBLE_SQL}
      LIMIT 1`,
    [callerId, callerId, callerId, eventId],
  );
  if (!visible[0]) {
    throw notFound('That event could not be found. It may have been cancelled, or it may not be shared with you.');
  }

  const [rows] = await pool.query<(RowDataPacket & { user_id: string; display_name: string; rsvped_at: Date | null })[]>(
    `SELECT r.user_id, u.display_name, r.rsvped_at
       FROM event_rsvps r
       JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ? AND r.status = 'going'
      ORDER BY r.rsvped_at ASC, r.user_id ASC
      LIMIT ? OFFSET ?`,
    [eventId, page.limit + 1, page.offset],
  );

  const hasMore = rows.length > page.limit;
  const visibleRows = hasMore ? rows.slice(0, page.limit) : rows;

  return {
    attendees: visibleRows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      isYou: row.user_id === callerId,
      rsvpedAt: toIso(row.rsvped_at),
    })),
    offset: page.offset,
    hasMore,
    nextOffset: hasMore ? page.offset + visibleRows.length : null,
  };
}

// -----------------------------------------------------------------------------
// Validation and normalisation of the writable fields
// -----------------------------------------------------------------------------

interface NormalizedFields {
  title: string;
  description: string;
  category: EventCategoryId;
  locationLabel: string | null;
}

/**
 * Checks and normalises the text fields.
 *
 * Lengths are enforced here as well as by the column CHECK so the member gets a
 * sentence ("An event title must be 80 characters or fewer") instead of a
 * constraint name, and so an over-long value never reaches the database at all.
 */
function normalizeFields(draft: {
  title: string;
  description: string;
  category: EventCategoryId;
  locationLabel: string | null;
}): NormalizedFields {
  const title = draft.title.trim();
  if (title.length < EVENT_TITLE_MIN_LENGTH) {
    throw badRequest(`An event title needs at least ${EVENT_TITLE_MIN_LENGTH} characters.`, { field: 'title' });
  }
  if (title.length > EVENT_TITLE_MAX_LENGTH) {
    throw badRequest(`An event title must be ${EVENT_TITLE_MAX_LENGTH} characters or fewer.`, { field: 'title' });
  }

  const description = draft.description.trim();
  if (description.length < 1) {
    throw badRequest('A description is required so people know what the event is.', { field: 'description' });
  }
  if (description.length > EVENT_DESCRIPTION_MAX_LENGTH) {
    throw badRequest(`The description must be ${EVENT_DESCRIPTION_MAX_LENGTH} characters or fewer.`, {
      field: 'description',
    });
  }

  const label = draft.locationLabel === null ? null : draft.locationLabel.trim();
  if (label !== null && label.length > 0) {
    // The rule itself lives in `domain/venue.ts` so the event form and the group
    // form can never disagree about what a venue name is. An empty label is not
    // refused here - an event with no anchor legitimately has none; whether an
    // anchor may exist without a name is decided where the coordinates are.
    const problem = venueLabelProblem(label, EVENT_LOCATION_LABEL_MAX_LENGTH);
    if (problem !== null) throw badRequest(problem, { field: 'locationLabel' });
  }

  return {
    title,
    description,
    category: draft.category,
    locationLabel: label !== null && label.length > 0 ? label : null,
  };
}

/** Parses a client timestamp into a `Date`, or explains what was wrong with it. */
function parseInstant(value: string, field: 'startAt' | 'endAt'): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(
      'That date and time could not be read. Send it as an ISO 8601 timestamp, e.g. 2026-10-10T18:00:00.000Z.',
      { field },
    );
  }
  return parsed;
}

/**
 * Validates the time window and converts it to UTC `Date` objects.
 *
 * `new Date(...)` on an ISO string with an offset yields the correct absolute
 * instant, and `db/pool.ts` pins every connection to `+00:00`, so the value is
 * written as UTC whatever timezone the device was in. `requireFutureStart` is
 * false for an edit that does not touch the start time, so extending an event that
 * is already under way stays possible.
 */
function normalizeWindow(
  startAt: string,
  endAt: string,
  options: { requireFutureStart: boolean },
): { startAt: Date; endAt: Date } {
  const start = parseInstant(startAt, 'startAt');
  const end = parseInstant(endAt, 'endAt');

  if (!isSaneEventWindow(start, end)) {
    throw badRequest(
      `An event has to end after it starts, and may not run for longer than ${EVENT_MAX_DURATION_DAYS} days.`,
      { field: 'endAt' },
    );
  }
  if (options.requireFutureStart && start.getTime() <= Date.now()) {
    throw badRequest('An event has to start in the future. Check the date and time.', { field: 'startAt' });
  }

  return { startAt: start, endAt: end };
}

/** `null` means "no capacity limit"; anything else must be a sane whole number. */
function normalizeCapacity(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EVENT_PARTICIPANTS) {
    throw badRequest(`A participant limit must be a whole number between 1 and ${MAX_EVENT_PARTICIPANTS}.`, {
      field: 'maxParticipants',
    });
  }
  return value;
}

/**
 * Validates a coordinate pair and rounds it to the stored precision (~11 m).
 *
 * `null`/`null` means "no anchor", which is a legitimate answer - an event can be
 * announced without a point. A half-supplied pair, an out-of-range value or the
 * exact (0, 0) reading (what a handset returns when it has no fix) is refused,
 * mirroring `locationService.setMyLocation` and the group anchor.
 */
function normalizeCoordinates(
  latitude: number | null,
  longitude: number | null,
): { latitude: number; longitude: number } | null {
  if (latitude === null && longitude === null) return null;

  if (latitude === null || longitude === null) {
    throw badRequest('An event location needs both a latitude and a longitude.', { field: 'location' });
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

/** Writes (or replaces) the event's geographic anchor. Longitude first, as always. */
async function writeEventLocation(
  connection: PoolConnection,
  eventId: string,
  coordinates: { latitude: number; longitude: number },
): Promise<void> {
  await connection.query(
    `INSERT INTO event_locations (event_id, latitude, longitude, location, location_updated_at)
     VALUES (?, ?, ?, ST_SRID(POINT(?, ?), 0), NOW(3)) AS incoming
     ON DUPLICATE KEY UPDATE
       latitude = incoming.latitude,
       longitude = incoming.longitude,
       location = incoming.location,
       location_updated_at = NOW(3)`,
    [eventId, coordinates.latitude, coordinates.longitude, coordinates.longitude, coordinates.latitude],
  );
}

/**
 * Whether the event currently has a geographic anchor.
 *
 * Read on its own rather than added to `getEvent`'s projection, because the answer
 * decides whether an edit that clears the venue label has to be refused (see
 * `updateEvent`), and that decision is made under the same lock as the write.
 */
async function hasEventLocation(connection: PoolConnection, eventId: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT 1 FROM event_locations WHERE event_id = ? LIMIT 1',
    [eventId],
  );
  return rows.length > 0;
}

/**
 * Refuses a member whose self-declared eligibility does not match a group event's
 * audience.
 *
 * This is the only place the rule lives for events, so a direct `POST /rsvp` and
 * the mobile button get the same answer. Like `groupService.assertAudienceEligible`
 * it takes the value the *server* read, so a client cannot assert its own
 * eligibility - and it is never applied to a member of the group, whose membership
 * is the stronger grant.
 */
function assertEventAudienceEligible(audience: GroupAudience, eligibility: GroupEligibility | null): void {
  if (isEligibleForAudience(audience, eligibility)) return;

  const detail =
    eligibility === null
      ? 'Your profile has no eligibility setting yet, so events restricted like this one are closed to you for now.'
      : 'Your eligibility setting does not match this event.';
  const label =
    audience === 'men_only' ? 'for men only' : audience === 'women_only' ? 'for women only' : 'open to everyone';

  throw new AppError('audience_not_eligible', 403, `This event follows its group's audience: ${label}. ${detail}`);
}

// -----------------------------------------------------------------------------
// Shared transaction helpers
//
// Every mutation starts by locking the event row, and the RSVP path locks the
// event *first* and the guest list second. That ordering is what makes two
// simultaneous requests for the last place resolve one after the other instead of
// both reading the same count.
// -----------------------------------------------------------------------------

interface EventLockRow extends RowDataPacket {
  id: string;
  title: string;
  description: string;
  category: string;
  start_at: Date;
  end_at: Date;
  location_label: string | null;
  created_by: string;
  group_id: string | null;
  max_participants: number | null;
  status: string;
  group_name: string | null;
  group_visibility: string | null;
  group_audience: string | null;
  group_archived_at: Date | null;
}

const EVENT_LOCK_COLUMNS = `
  e.id,
  e.title,
  e.description,
  e.category,
  e.start_at,
  e.end_at,
  e.location_label,
  e.created_by,
  e.group_id,
  e.max_participants,
  e.status,
  g.name AS group_name,
  g.visibility AS group_visibility,
  g.audience AS group_audience,
  g.archived_at AS group_archived_at
`;

/**
 * Locks an event the caller is allowed to read, for a mutation that must not leak
 * the existence of a private one.
 *
 * The visibility predicate is part of the locking read, so a non-member of a
 * private group gets the same 404 as an unknown id - the difference between "you
 * cannot change this" (403, for an event you can see) and "this does not exist"
 * (404) stays meaningful without ever confirming an inaccessible event is real.
 */
async function lockVisibleEvent(
  connection: PoolConnection,
  eventId: string,
  callerId: string,
): Promise<EventLockRow> {
  const [rows] = await connection.query<EventLockRow[]>(
    `SELECT ${EVENT_LOCK_COLUMNS}
       FROM events e
       JOIN profiles me ON me.user_id = ?
       LEFT JOIN \`groups\` g ON g.id = e.group_id
       LEFT JOIN group_memberships viewer ON viewer.group_id = e.group_id AND viewer.user_id = ?
      WHERE e.id = ?
        AND ${EVENT_VISIBLE_SQL}
      FOR UPDATE`,
    [callerId, callerId, eventId],
  );

  const row = rows[0];
  if (!row) {
    throw notFound('That event could not be found. It may have been cancelled, or it may not be shared with you.');
  }
  return row;
}

/**
 * Locks an event with no visibility filter, for the RSVP path.
 *
 * RSVP does not want a silent 404 for every refusal: a member whose eligibility
 * does not match a *public* group's audience deserves to be told why, and a
 * private event must still answer 404. Deriving that needs the row first, so this
 * read takes it and `assertGroupEventAccess` decides. Only reachable from inside a
 * transaction.
 */
async function lockEventRaw(connection: PoolConnection, eventId: string): Promise<EventLockRow> {
  const [rows] = await connection.query<EventLockRow[]>(
    `SELECT ${EVENT_LOCK_COLUMNS}
       FROM events e
       LEFT JOIN \`groups\` g ON g.id = e.group_id
      WHERE e.id = ?
      FOR UPDATE`,
    [eventId],
  );

  const row = rows[0];
  if (!row) throw notFound('That event could not be found.');
  return row;
}

interface GroupLockRow extends RowDataPacket {
  id: string;
  name: string;
  visibility: string;
  audience: string;
  archived_at: Date | null;
}

/** Locks a group row and refuses an archived one. */
async function lockGroupRow(connection: PoolConnection, groupId: string): Promise<GroupLockRow> {
  const [rows] = await connection.query<GroupLockRow[]>(
    'SELECT id, name, visibility, audience, archived_at FROM `groups` WHERE id = ? FOR UPDATE',
    [groupId],
  );

  const row = rows[0];
  if (!row) throw badRequest('That group could not be found.', { field: 'groupId' });
  if (row.archived_at !== null) {
    throw new AppError('group_archived', 409, 'That group has been archived, so it cannot host new events.');
  }
  return row;
}

interface RsvpRow extends RowDataPacket {
  id: string;
  event_id: string;
  user_id: string;
  status: string;
}

/** The caller's own RSVP row, locked. */
async function lockRsvp(connection: PoolConnection, eventId: string, userId: string): Promise<RsvpRow | null> {
  const [rows] = await connection.query<RsvpRow[]>(
    `SELECT id, event_id, user_id, status
       FROM event_rsvps
      WHERE event_id = ? AND user_id = ?
      FOR UPDATE`,
    [eventId, userId],
  );
  return rows[0] ?? null;
}

/**
 * The number of places already taken, with those rows locked.
 *
 * Locking the rows matters as much as counting them: the event row is already
 * locked by the caller, so the count is stable, and holding the going rows means a
 * rollback cannot leave the guest list half-updated. It runs only for an event
 * that has a capacity, which is the only case that needs the number.
 */
async function lockGoingCount(connection: PoolConnection, eventId: string): Promise<number> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT id FROM event_rsvps WHERE event_id = ? AND status = 'going' FOR UPDATE",
    [eventId],
  );
  return rows.length;
}

/** A plain count, for the capacity check on an edit. */
async function countGoing(connection: PoolConnection, eventId: string): Promise<number> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS going FROM event_rsvps WHERE event_id = ? AND status = 'going'",
    [eventId],
  );
  return Number(rows[0]?.going ?? 0);
}

/**
 * Whether the caller may edit or cancel an event, from stored rows only.
 *
 * The rule, in full:
 *
 *   * a **standalone** event belongs to the member who created it;
 *   * a **group** event's creator keeps the controls only while they are still an
 *     active member of the group - leaving (or being removed) hands the event to
 *     the group, which is what stops a former member of a private group from
 *     editing something they can no longer even read (they cannot reach this
 *     function: the visibility check 404s first);
 *   * the group's **owner or an administrator** may always manage its events, which
 *     is the documented recovery path if the creator disappears.
 */
async function assertCanManageEvent(
  connection: PoolConnection,
  event: EventLockRow,
  callerId: string,
): Promise<void> {
  const isCreator = event.created_by === callerId;

  if (event.group_id === null) {
    if (!isCreator) throw forbidden('Only the member who created this event can change it.');
    return;
  }

  const role = await activeRoleOf(connection, event.group_id, callerId);
  if (role === 'owner' || role === 'admin') return;
  if (isCreator && role === 'member') return;

  if (isCreator) {
    throw forbidden('You are no longer a member of the group that hosts this event, so the group manages it now.');
  }
  throw forbidden('Only the member who created this event, or an owner or administrator of its group, can change it.');
}

/**
 * Whether the caller may RSVP to a group event, from stored rows only.
 *
 * A member of the group passes whatever their eligibility setting says now - their
 * membership is the stronger grant, and the group page they can already read works
 * the same way. Everyone else needs a public, unarchived group whose audience
 * accepts them; a private event stays a 404, and a mismatched audience is a 403
 * with a sentence that points at the eligibility setting.
 */
async function assertGroupEventAccess(
  connection: PoolConnection,
  event: EventLockRow,
  callerId: string,
): Promise<void> {
  if (event.group_id === null) return;

  const role = await activeRoleOf(connection, event.group_id, callerId);
  if (role !== null) return;

  if (event.group_visibility !== 'public' || event.group_archived_at !== null) {
    throw notFound('That event could not be found. It may have been cancelled, or it may not be shared with you.');
  }

  const eligibility = await readEligibility(connection, callerId);
  assertEventAudienceEligible(event.group_audience as GroupAudience, eligibility);
}

/** Requires a membership that is active, for hosting an event in a group. */
async function requireActiveGroupMember(
  connection: PoolConnection,
  groupId: string,
  callerId: string,
): Promise<void> {
  const role = await activeRoleOf(connection, groupId, callerId);
  if (role === null) {
    throw forbidden('You can only host an event for a group you are an active member of.');
  }
}

// -----------------------------------------------------------------------------
// Creation, editing and cancelling
// -----------------------------------------------------------------------------

/**
 * Creates an event, standalone or attached to a group.
 *
 * The creator is always the caller: the draft has no `createdBy` field, so a
 * crafted body cannot name someone else as the organiser. Attaching the event to a
 * group is a *membership* decision, checked against the stored rows inside the same
 * transaction as the insert - a member of the group may host for it, and nobody
 * else may attach an event to it at all.
 *
 * The geographic anchor is whatever the client explicitly sent after the member
 * tapped "use my location" in the form. An event created without one simply has no
 * anchor: it is a perfectly valid event, it appears in the group's own list, and it
 * never appears in a nearby search.
 */
export async function createEvent(callerId: string, draft: EventDraft): Promise<EventSummary> {
  const fields = normalizeFields(draft);
  const window = normalizeWindow(draft.startAt, draft.endAt, { requireFutureStart: true });
  const capacity = normalizeCapacity(draft.maxParticipants);
  const coordinates = draft.removeLocation ? null : normalizeCoordinates(draft.latitude, draft.longitude);
  // A pin on its own does not say where to meet. The check runs after
  // `normalizeCoordinates`, so a half-supplied pair still gets its own, more
  // specific sentence rather than this one.
  if (coordinates !== null && fields.locationLabel === null) {
    throw badRequest(VENUE_LABEL_REQUIRED_MESSAGE, { field: 'locationLabel' });
  }
  const eventId = newId();

  await withTransaction(async (connection) => {
    if (draft.groupId !== null) {
      const group = await lockGroupRow(connection, draft.groupId);
      const eligibility = await readEligibility(connection, callerId);
      await requireActiveGroupMember(connection, draft.groupId, callerId);
      assertEventAudienceEligible(group.audience as GroupAudience, eligibility);
    }

    await connection.query(
      `INSERT INTO events
         (id, title, description, category, start_at, end_at, location_label, created_by, group_id, max_participants)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        fields.title,
        fields.description,
        fields.category,
        window.startAt,
        window.endAt,
        fields.locationLabel,
        callerId,
        draft.groupId,
        capacity,
      ],
    );

    if (coordinates) await writeEventLocation(connection, eventId, coordinates);
  });

  return getEvent(callerId, eventId);
}

/**
 * Edits an event.
 *
 * The merged draft is validated as a whole, so a patch that only changes the
 * description is checked against the stored title, times and capacity exactly as a
 * full edit would be. Two rules are specific to editing:
 *
 *   * a **cancelled** event cannot be re-opened or changed - there is no
 *     resurrection path in this phase;
 *   * a capacity may not be lowered below the number of members already going, so
 *     the limit never contradicts the guest list. That count is read inside the
 *     transaction, after the event row is locked.
 *
 * `startAt` is only required to be in the future when the patch actually changes
 * it, so correcting the description of an event that is under way still works.
 */
export async function updateEvent(callerId: string, eventId: string, patch: EventPatch): Promise<EventSummary> {
  await withTransaction(async (connection) => {
    const current = await lockVisibleEvent(connection, eventId, callerId);
    if (current.status === 'cancelled') {
      throw new AppError('event_cancelled', 409, 'This event was cancelled, so it cannot be edited.');
    }
    if (current.group_id !== null) await lockGroupRow(connection, current.group_id);
    await assertCanManageEvent(connection, current, callerId);

    const fields = normalizeFields({
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      category: (patch.category ?? current.category) as EventCategoryId,
      locationLabel: patch.locationLabel === undefined ? current.location_label : patch.locationLabel,
    });

    const window = normalizeWindow(
      patch.startAt ?? current.start_at.toISOString(),
      patch.endAt ?? current.end_at.toISOString(),
      { requireFutureStart: patch.startAt !== undefined },
    );

    const capacity = normalizeCapacity(
      patch.maxParticipants === undefined ? current.max_participants : patch.maxParticipants,
    );
    if (capacity !== null) {
      const going = await countGoing(connection, eventId);
      if (capacity < going) {
        throw badRequest(`There are already ${going} people going, so the limit cannot be lower than that.`, {
          field: 'maxParticipants',
        });
      }
    }

    await connection.query(
      `UPDATE events
          SET title = ?, description = ?, category = ?, start_at = ?, end_at = ?, location_label = ?, max_participants = ?
        WHERE id = ?`,
      [
        fields.title,
        fields.description,
        fields.category,
        window.startAt,
        window.endAt,
        fields.locationLabel,
        capacity,
        eventId,
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
    const anchored = coordinates === undefined ? await hasEventLocation(connection, eventId) : coordinates !== null;

    // A pin never outlives its name - including on an edit that only clears the
    // venue label, which would otherwise leave a coordinate pair with nothing to
    // read.
    if (anchored && fields.locationLabel === null) {
      throw badRequest(VENUE_LABEL_REQUIRED_MESSAGE, { field: 'locationLabel' });
    }

    if (coordinates === null) {
      await connection.query('DELETE FROM event_locations WHERE event_id = ?', [eventId]);
    } else if (coordinates !== undefined) {
      await writeEventLocation(connection, eventId, coordinates);
    }
  });

  return getEvent(callerId, eventId);
}

/**
 * Cancels an event - the only "delete" this phase has.
 *
 * Nothing is removed: the RSVP rows stay, so the attendance history remains
 * readable, and every listing, RSVP and edit path refuses a cancelled event with
 * `event_cancelled`. Idempotent in the sense that a second call is a no-op rather
 * than an error - a retried request after a dropped response should not fail.
 */
export async function cancelEvent(callerId: string, eventId: string): Promise<EventSummary> {
  await withTransaction(async (connection) => {
    const current = await lockVisibleEvent(connection, eventId, callerId);
    if (current.group_id !== null) await lockGroupRow(connection, current.group_id);
    await assertCanManageEvent(connection, current, callerId);

    if (current.status === 'cancelled') return;

    await connection.query("UPDATE events SET status = 'cancelled', cancelled_at = NOW(3) WHERE id = ?", [eventId]);
  });

  return getEvent(callerId, eventId);
}

// -----------------------------------------------------------------------------
// RSVPs
// -----------------------------------------------------------------------------

/**
 * Signs the caller up for an event, exactly once.
 *
 * The order of the checks is the whole design:
 *
 *   1. the event row is locked, which serialises every RSVP for that event;
 *   2. a cancelled or finished event is refused with its own error code;
 *   3. group access is re-derived from the stored membership and the caller's own
 *      eligibility;
 *   4. an existing *going* row returns immediately - a double tap is a success,
 *      not a second guest;
 *   5. only then is capacity checked, under the same lock, so two requests for the
 *      last place cannot both win. Re-joining after a cancellation updates the
 *      existing row rather than inserting a second one.
 *
 * Nothing in this function reads a count, a status or a creator from the request.
 */
export async function rsvpToEvent(callerId: string, eventId: string): Promise<EventSummary> {
  await writeRsvpAnswer(callerId, eventId, 'going');
  return getEvent(callerId, eventId);
}

/**
 * Records the caller's explicit answer to an event (Phase 7).
 *
 * `going` and `not_going` are answers; **withdrawing** the RSVP (`cancelRsvp`,
 * `DELETE /api/events/:id/rsvp`) is the absence of one, and the two are kept apart
 * on purpose:
 *
 *   * `not_going` is a statement about the event. It puts the event in the "Not
 *     going" filter, it is a response the organiser can count, and it never
 *     consumes a place.
 *   * a withdrawal clears the member's answer. The event moves back to "Needs
 *     response", which is what the filter means.
 *
 * Both are idempotent, and both keep the single `(event, member)` row rather than
 * creating a second one - "have I answered?" is one indexed lookup either way.
 */
export async function setEventRsvp(
  callerId: string,
  eventId: string,
  status: RsvpAnswer,
): Promise<EventSummary> {
  await writeRsvpAnswer(callerId, eventId, status);
  return getEvent(callerId, eventId);
}

/**
 * The one write path for both answers.
 *
 * Everything the answer depends on is read inside this transaction: the event row
 * (locked), the caller's membership of the hosting group, the group's archived
 * state, the caller's own RSVP row and - only when a place is actually at stake -
 * the number of members already going. Nothing is taken from the request except the
 * answer itself, and `callerId` always comes from the session.
 *
 * The capacity check runs **before** the status changes and only for `going`, so
 * moving from Not going to Going on a full event is refused with `event_full` and
 * leaves the previous answer in place. Not going never touches capacity: it is not
 * an attendance.
 */
async function writeRsvpAnswer(callerId: string, eventId: string, status: RsvpAnswer): Promise<void> {
  await withTransaction(async (connection) => {
    const event = await lockEventRaw(connection, eventId);

    if (event.status === 'cancelled') {
      throw new AppError('event_cancelled', 409, 'This event was cancelled, so no response can be recorded now.');
    }
    if (event.end_at.getTime() <= Date.now()) {
      throw new AppError('event_ended', 409, 'This event has already finished, so no new response can be recorded.');
    }

    await assertGroupEventAccess(connection, event, callerId);

    if (event.group_archived_at !== null) {
      throw new AppError(
        'group_archived',
        409,
        'The group hosting this event has been archived, so the event is closed.',
      );
    }

    const existing = await lockRsvp(connection, eventId, callerId);
    // Idempotent, timestamp included: answering the same way twice must not shuffle
    // a guest list or make a "response received" notice flicker.
    if (existing && existing.status === status) return;

    if (status === 'going' && event.max_participants !== null) {
      const going = await lockGoingCount(connection, eventId);
      if (going >= Number(event.max_participants)) {
        throw new AppError('event_full', 409, 'This event is full, so no more places are available.');
      }
    }

    if (existing) {
      // One row per (event, member), reused forever: `rsvped_at` is rewritten so the
      // guest list order still reflects when the member last answered, and
      // `cancelled_at` is cleared because neither answer is a withdrawal - the
      // schema's two-column CHECK would refuse the row otherwise.
      await connection.query(
        'UPDATE event_rsvps SET status = ?, rsvped_at = NOW(3), cancelled_at = NULL WHERE id = ?',
        [status, existing.id],
      );
      return;
    }

    await connection.query(
      'INSERT INTO event_rsvps (id, event_id, user_id, status, rsvped_at) VALUES (?, ?, ?, ?, NOW(3))',
      [newId(), eventId, callerId, status],
    );
  });
}

/**
 * Cancels the caller's own RSVP.
 *
 * A no-op when there is nothing to cancel, and a no-op when the row is already
 * cancelled: "I am not going" is already true, so repeating the request is a
 * success rather than an error the member cannot act on. The row is *kept* and
 * marked `cancelled`, which is what keeps the attendance history intact while
 * removing the member from the active count and from Going.
 *
 * Cancelling is allowed for a cancelled or finished event on purpose - withdrawing
 * is always safe, and refusing it would leave someone counted as going to
 * something that no longer exists.
 */
export async function cancelRsvp(callerId: string, eventId: string): Promise<EventSummary> {
  await withTransaction(async (connection) => {
    // Readable by the caller, or there is nothing of theirs to cancel. This is also
    // what stops a crafted id from being used to probe an unknown event.
    await lockVisibleEvent(connection, eventId, callerId);

    const existing = await lockRsvp(connection, eventId, callerId);
    if (!existing || existing.status === 'cancelled') return;

    await connection.query("UPDATE event_rsvps SET status = 'cancelled', cancelled_at = NOW(3) WHERE id = ?", [
      existing.id,
    ]);
  });

  return getEvent(callerId, eventId);
}

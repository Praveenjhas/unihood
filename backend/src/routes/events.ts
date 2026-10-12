/**
 * Events.
 *
 *   GET    /api/events/nearby?q=&category=&radius=&limit=&offset=
 *          -> { page: { events, offset, hasMore, nextOffset } }   (distanceMeters set)
 *   GET    /api/events/mine?limit=&offset=        -> { page: { events, … } }
 *   GET    /api/events/going?limit=&offset=       -> { page: { events, … } }
 *   GET    /api/events/feed?response=&q=&category=&limit=&offset=
 *          -> { page: { events, … } }   (upcoming group events; the Events tab's list)
 *   GET    /api/events?q=&category=&groupId=&limit=&offset=
 *          -> { page: { events, offset, hasMore, nextOffset } }
 *   GET    /api/events/:id                        -> { event }
 *   POST   /api/events                            -> 201 { event }
 *   PATCH  /api/events/:id                        -> { event }
 *   DELETE /api/events/:id                        -> { event } (cancel)
 *   POST   /api/events/:id/rsvp                   -> { event }   (going)
 *   PUT    /api/events/:id/rsvp                   -> { event }   (going | not_going)
 *   DELETE /api/events/:id/rsvp                   -> { event }   (withdraw - no answer)
 *   GET    /api/events/:id/attendees?limit=&offset= -> { page: { attendees, … } }
 *
 * `/nearby`, `/mine`, `/going` and `/feed` are declared before `/:id` on purpose:
 * Express matches in declaration order, so a literal segment registered late would
 * be swallowed by the id parameter.
 *
 * Since Phase 7 the Events tab reads `/feed`, which is the unified upcoming list of
 * the caller's own groups' events; `response=` (upcoming | needs_response | going |
 * not_going) filters that one list by the caller's response state. The other
 * listings are kept because they still answer different questions - `nearby` is
 * geographic, `mine`/`going` predate the feed and are still used by the profile
 * summary - and none of them is more permissive: each applies the same visibility
 * predicate as the detail page.
 *
 * Every mutation answers with the refreshed event, so the client never invents a
 * post-action state, and cancelling returns the event (rather than a bare 204)
 * because the page has to be able to say "cancelled". The zod schemas here
 * deliberately check *types and shapes* only: lengths, the time window, the
 * capacity, group membership and every authorization decision are enforced in
 * `services/eventService.ts`, next to the SQL, where the API and the database
 * cannot disagree.
 *
 * `groupId` is accepted when creating an event and rejected (by omission) when
 * editing one: an event does not move between groups, which is what stops a
 * crafted `PATCH` from re-targeting an event at a group the caller does not belong
 * to.
 */
import { Router } from 'express';
import { z } from 'zod';

import { DEFAULT_RADIUS_METERS, MAX_RADIUS_METERS } from '../domain/geo';
import {
  ATTENDEE_PAGE_SIZE,
  EVENT_CATEGORY_IDS,
  EVENT_FEED_FILTERS,
  EVENT_PAGE_SIZE,
  MAX_ATTENDEE_PAGE_SIZE,
  MAX_EVENT_PAGE_SIZE,
  MAX_EVENT_PARTICIPANTS,
  type EventCategoryId,
  type EventFeedFilter,
  type RsvpAnswer,
} from '../domain/events';
import { parseBody, parseParams, parseQuery } from '../http/validate';
import { asyncHandler } from '../lib/asyncHandler';
import { getAuth, requireAuth } from '../middleware/requireAuth';
import {
  cancelEvent,
  cancelRsvp,
  createEvent,
  getEvent,
  listEventAttendees,
  listEvents,
  listGoingEvents,
  listGroupEventFeed,
  listMyGroupEvents,
  listNearbyEvents,
  rsvpToEvent,
  setEventRsvp,
  updateEvent,
  type EventDraft,
  type EventPatch,
} from '../services/eventService';

export const eventsRouter = Router();

const eventIdParamsSchema = z.object({
  id: z.string().uuid('That event link is not valid.'),
});

const listQuerySchema = z.object({
  q: z.string().max(120).optional(),
  /** Comma-separated category ids; the same shape the group filter uses. */
  category: z.string().max(200).optional(),
  groupId: z.string().uuid('That group link is not valid.').optional(),
  limit: z.coerce.number().int().min(1).max(MAX_EVENT_PAGE_SIZE).default(EVENT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/**
 * The radius is accepted generously and clamped by the service to the shared
 * 1-10 km window, exactly as the People and Groups searches do: a client asking
 * for a silly radius gets a sane answer rather than a 400.
 */
const nearbyQuerySchema = listQuerySchema.extend({
  radius: z.coerce.number().int().min(0).max(MAX_RADIUS_METERS * 10).optional(),
});

const attendeeQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_ATTENDEE_PAGE_SIZE).default(ATTENDEE_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/**
 * The unified feed's own query.
 *
 * `response` is an enum, not a coerced boolean or a free string: the four values are
 * the four filters the Events tab offers, and an unknown one is a `400` rather than
 * a silently-unfiltered list. Defaulting to `upcoming` means the plain endpoint
 * answers the most useful question without any parameter at all.
 */
const feedQuerySchema = listQuerySchema.extend({
  response: z.enum(EVENT_FEED_FILTERS).default('upcoming'),
});

const rsvpAnswerSchema = z.object({
  status: z.enum(['going', 'not_going'], {
    errorMap: () => ({ message: 'Answer with either going or not_going.' }),
  }),
});

const instantSchema = z
  .string()
  .max(40)
  .datetime({ offset: true, message: 'Use an ISO 8601 date and time, e.g. 2026-10-10T18:00:00.000Z.' });

/**
 * Generous upper bounds - the real limits are smaller and are reported with
 * member-facing wording by the service. These exist so an oversized payload cannot
 * reach the service at all.
 */
const eventDraftSchema = z.object({
  title: z.string().max(400),
  description: z.string().max(3000),
  category: z.enum(EVENT_CATEGORY_IDS),
  startAt: instantSchema,
  endAt: instantSchema,
  locationLabel: z.string().max(400).nullish(),
  latitude: z.number().finite('Latitude must be a number.').nullish(),
  longitude: z.number().finite('Longitude must be a number.').nullish(),
  removeLocation: z.boolean().optional(),
  groupId: z.string().uuid('That group link is not valid.').nullish(),
  maxParticipants: z.number().int().min(1).max(MAX_EVENT_PARTICIPANTS).nullish(),
});

/** `groupId` is not patchable: an event does not move between groups. */
const eventPatchSchema = eventDraftSchema.partial().omit({ groupId: true });

/** `a,b,,c` -> `['a','b','c']`, keeping only ids the vocabulary knows. */
function splitCategories(value: string | undefined): EventCategoryId[] {
  if (!value) return [];
  const known = new Set<string>(EVENT_CATEGORY_IDS);
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => known.has(entry)) as EventCategoryId[];
}

/** Turns a parsed body into the service's input shape. */
function toDraft(body: z.infer<typeof eventDraftSchema>): EventDraft {
  return {
    title: body.title,
    description: body.description,
    category: body.category as EventCategoryId,
    startAt: body.startAt,
    endAt: body.endAt,
    locationLabel: body.locationLabel ?? null,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    removeLocation: body.removeLocation === true,
    groupId: body.groupId ?? null,
    maxParticipants: body.maxParticipants ?? null,
  };
}

/**
 * Turns a parsed patch into the service's input shape, keeping "absent" distinct
 * from "explicitly null".
 *
 * That difference matters: omitting `locationLabel` leaves the stored one alone,
 * while sending `null` clears it, and the same is true of the coordinate pair and
 * the capacity.
 */
function toPatch(body: z.infer<typeof eventPatchSchema>): EventPatch {
  const patch: EventPatch = {};

  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.category !== undefined) patch.category = body.category as EventCategoryId;
  if (body.startAt !== undefined) patch.startAt = body.startAt;
  if (body.endAt !== undefined) patch.endAt = body.endAt;
  if (body.locationLabel !== undefined) patch.locationLabel = body.locationLabel ?? null;
  if (body.latitude !== undefined) patch.latitude = body.latitude ?? null;
  if (body.longitude !== undefined) patch.longitude = body.longitude ?? null;
  if (body.removeLocation !== undefined) patch.removeLocation = body.removeLocation;
  if (body.maxParticipants !== undefined) patch.maxParticipants = body.maxParticipants ?? null;

  return patch;
}

// -----------------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------------

eventsRouter.get(
  '/nearby',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(nearbyQuerySchema, request);

    const page = await listNearbyEvents(getAuth(request).userId, {
      query: query.q ?? '',
      categories: splitCategories(query.category),
      groupId: query.groupId ?? null,
      limit: query.limit,
      offset: query.offset,
      radiusMeters: query.radius ?? DEFAULT_RADIUS_METERS,
    });

    response.json({ page });
  }),
);

eventsRouter.get(
  '/mine',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(listQuerySchema, request);

    const page = await listMyGroupEvents(getAuth(request).userId, {
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

/**
 * The Events tab's list: upcoming events hosted by groups the caller is an active
 * member of, filtered by the caller's own response state.
 *
 * Declared before `/:id` (with `/nearby`, `/mine` and `/going`) so the literal
 * `feed` segment is not read as an event id.
 */
eventsRouter.get(
  '/feed',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(feedQuerySchema, request);

    const page = await listGroupEventFeed(getAuth(request).userId, {
      query: query.q ?? '',
      categories: splitCategories(query.category),
      groupId: query.groupId ?? null,
      response: query.response as EventFeedFilter,
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

eventsRouter.get(
  '/going',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(listQuerySchema, request);

    const page = await listGoingEvents(getAuth(request).userId, {
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

eventsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(listQuerySchema, request);

    const page = await listEvents(getAuth(request).userId, {
      query: query.q ?? '',
      categories: splitCategories(query.category),
      groupId: query.groupId ?? null,
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

eventsRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(eventIdParamsSchema, request);

    const event = await getEvent(getAuth(request).userId, params.id);
    response.json({ event });
  }),
);

// -----------------------------------------------------------------------------
// Creation and management
// -----------------------------------------------------------------------------

eventsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (request, response) => {
    const body = parseBody(eventDraftSchema, request);

    const event = await createEvent(getAuth(request).userId, toDraft(body));
    response.status(201).json({ event });
  }),
);

eventsRouter.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(eventIdParamsSchema, request);
    const body = parseBody(eventPatchSchema, request);

    const event = await updateEvent(getAuth(request).userId, params.id, toPatch(body));
    response.json({ event });
  }),
);

eventsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(eventIdParamsSchema, request);

    const event = await cancelEvent(getAuth(request).userId, params.id);
    response.json({ event });
  }),
);

// -----------------------------------------------------------------------------
// RSVPs and the guest list
// -----------------------------------------------------------------------------

eventsRouter.post(
  '/:id/rsvp',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(eventIdParamsSchema, request);

    const event = await rsvpToEvent(getAuth(request).userId, params.id);
    response.json({ event });
  }),
);

/**
 * The explicit answer (Phase 7): `going` or `not_going`.
 *
 * Kept separate from `DELETE` on the same path, because the two mean different
 * things: `not_going` says "I saw this and I am not coming", while deleting the RSVP
 * says "I have no answer" - which is why a withdrawn event returns to Needs response
 * and a declined one stays in Not going.
 */
eventsRouter.put(
  '/:id/rsvp',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(eventIdParamsSchema, request);
    const body = parseBody(rsvpAnswerSchema, request);

    const event = await setEventRsvp(getAuth(request).userId, params.id, body.status as RsvpAnswer);
    response.json({ event });
  }),
);

eventsRouter.delete(
  '/:id/rsvp',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(eventIdParamsSchema, request);

    const event = await cancelRsvp(getAuth(request).userId, params.id);
    response.json({ event });
  }),
);

eventsRouter.get(
  '/:id/attendees',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(eventIdParamsSchema, request);
    const query = parseQuery(attendeeQuerySchema, request);

    const page = await listEventAttendees(getAuth(request).userId, params.id, {
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

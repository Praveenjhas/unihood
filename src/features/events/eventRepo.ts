/**
 * Events data access.
 *
 * One module for every event call, exactly as `groupRepo` is for groups: the
 * screens work with camel-cased records, and nothing above this file knows a URL.
 *
 * Four details are worth stating because screens depend on them:
 *
 *   * `nearby` needs a fix the server already holds. When it does not, the API
 *     answers `location_required`, which callers detect with
 *     `hasApiErrorCode(caught, 'location_required')` and turn into an explanation
 *     rather than an error banner - because My groups and Going keep working.
 *   * `audience_not_eligible` (403) is a *final* answer, not a retry: the member's
 *     own eligibility setting is the thing to change, and the UI links there.
 *   * `event_full` / `event_ended` / `event_cancelled` (409) are final too - the
 *     screen keeps the state the server reported and explains it.
 *   * `fetchEvent` throws `EventNotAvailableError` for a 404, so a private event
 *     (which the API deliberately answers 404 for) reads as "not available" rather
 *     than as a failure worth retrying.
 *
 * `distanceMeters` is server-rounded; the UI formats it with
 * `formatApproximateDistance`, which never shows an exact figure.
 */
import { DEFAULT_RADIUS_METERS, apiRequest, clampRadiusMeters, hasApiErrorCode } from '../../lib';
import {
  EVENT_CATEGORY_IDS,
  EVENT_PAGE_SIZE,
  type CampusEvent,
  type EventAttendee,
  type EventAttendeePage,
  type EventBody,
  type EventCategoryId,
  type EventFeedFilterId,
  type EventPage,
  type EventStatus,
  type RsvpAnswer,
  type RsvpStatus,
} from '../../types';

/** The largest page the API accepts. */
const MAX_PAGE_SIZE = 50;

/** Which listing to read. `all` is the non-geographic directory. */
export type EventListMode = 'nearby' | 'mine' | 'going' | 'all';

/** One event as it arrives on the wire. */
interface EventPayload {
  id?: string;
  title?: string;
  description?: string;
  category?: string;
  startAt?: string | null;
  endAt?: string | null;
  locationLabel?: string | null;
  hasLocation?: boolean;
  distanceMeters?: number | null;
  groupId?: string | null;
  groupName?: string | null;
  groupVisibility?: string | null;
  groupAudience?: string | null;
  groupArchived?: boolean;
  creatorId?: string;
  creatorName?: string;
  maxParticipants?: number | null;
  goingCount?: number;
  spotsLeft?: number | null;
  isFull?: boolean;
  status?: string;
  cancelledAt?: string | null;
  isPast?: boolean;
  viewerRsvpStatus?: string | null;
  viewerIsGoing?: boolean;
  viewerIsCreator?: boolean;
  viewerCanManage?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface EventPagePayload {
  page?: {
    events?: EventPayload[] | null;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  };
}

interface AttendeePayload {
  userId?: string;
  displayName?: string;
  isYou?: boolean;
  rsvpedAt?: string | null;
}

interface AttendeePagePayload {
  page?: {
    attendees?: AttendeePayload[] | null;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  };
}

const CATEGORY_IDS = new Set<string>(EVENT_CATEGORY_IDS);

/** Keeps an unknown server value from reaching a component that switches on it. */
function asCategory(value: string | undefined): EventCategoryId {
  return value !== undefined && CATEGORY_IDS.has(value) ? (value as EventCategoryId) : 'general';
}

function asStatus(value: string | undefined): EventStatus {
  return value === 'cancelled' ? 'cancelled' : 'scheduled';
}

function asRsvpStatus(value: string | null | undefined): RsvpStatus | null {
  return value === 'going' || value === 'not_going' || value === 'cancelled' ? value : null;
}

function asVisibility(value: string | null | undefined): 'public' | 'private' | null {
  if (value === 'public' || value === 'private') return value;
  return null;
}

function asAudience(value: string | null | undefined): 'everyone' | 'men_only' | 'women_only' | null {
  if (value === 'everyone' || value === 'men_only' || value === 'women_only') return value;
  return null;
}

function mapEvent(payload: EventPayload): CampusEvent {
  return {
    id: String(payload.id ?? ''),
    title: String(payload.title ?? 'Untitled event'),
    description: String(payload.description ?? ''),
    category: asCategory(payload.category),
    startAt: String(payload.startAt ?? ''),
    endAt: String(payload.endAt ?? payload.startAt ?? ''),
    locationLabel: payload.locationLabel ?? null,
    hasLocation: payload.hasLocation === true,
    distanceMeters: payload.distanceMeters ?? null,
    groupId: payload.groupId ?? null,
    groupName: payload.groupName ?? null,
    groupVisibility: asVisibility(payload.groupVisibility),
    groupAudience: asAudience(payload.groupAudience),
    groupArchived: payload.groupArchived === true,
    creatorId: String(payload.creatorId ?? ''),
    creatorName: String(payload.creatorName ?? 'A member'),
    maxParticipants: payload.maxParticipants ?? null,
    goingCount: payload.goingCount ?? 0,
    spotsLeft: payload.spotsLeft ?? null,
    isFull: payload.isFull === true,
    status: asStatus(payload.status),
    cancelledAt: payload.cancelledAt ?? null,
    isPast: payload.isPast === true,
    viewerRsvpStatus: asRsvpStatus(payload.viewerRsvpStatus),
    viewerIsGoing: payload.viewerIsGoing === true,
    viewerIsCreator: payload.viewerIsCreator === true,
    viewerCanManage: payload.viewerCanManage === true,
    createdAt: payload.createdAt ?? null,
    updatedAt: payload.updatedAt ?? null,
  };
}

export interface EventQueryOptions {
  mode: EventListMode;
  /** Free text matched against the title, description and venue label. */
  query?: string;
  /** Category ids to filter by; an empty list means "no filter". */
  categories?: readonly EventCategoryId[];
  /** Restricts the listing to one group's own events (`all` mode). */
  groupId?: string | null;
  /** Nearby mode only; clamped to the server's 1-10 km window. */
  radiusMeters?: number;
  limit?: number;
  offset?: number;
}

/** The path for a mode, so the four listings cannot drift apart in one place. */
function pathFor(options: EventQueryOptions): string {
  switch (options.mode) {
    case 'nearby':
      return '/api/events/nearby';
    case 'mine':
      return '/api/events/mine';
    case 'going':
      return '/api/events/going';
    case 'all':
      return '/api/events';
  }
}

/**
 * One page of events.
 *
 * The server reports `hasMore` and the next offset; the local fallbacks keep a
 * short page from looking like the end of the list if a future response omits them.
 * A row without an id is dropped rather than rendered as a dead card.
 */
export async function fetchEventsPage(options: EventQueryOptions): Promise<EventPage> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(options.limit ?? EVENT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const categories = options.categories && options.categories.length > 0 ? [...options.categories] : null;

  const payload = await apiRequest<EventPagePayload>(pathFor(options), {
    query: {
      q: options.query?.trim() ?? '',
      category: categories?.join(',') ?? '',
      groupId: options.groupId ?? undefined,
      radius: options.mode === 'nearby' ? clampRadiusMeters(options.radiusMeters ?? DEFAULT_RADIUS_METERS) : undefined,
      limit,
      offset,
    },
  });

  const page = payload?.page;
  const events = (page?.events ?? []).map(mapEvent).filter((event) => event.id.length > 0);
  const hasMore = page?.hasMore ?? events.length === limit;

  return {
    events,
    offset: page?.offset ?? offset,
    hasMore,
    nextOffset: page?.nextOffset ?? (hasMore ? offset + events.length : null),
  };
}

/**
 * The API's spelling of a feed filter.
 *
 * `needs-response` is the chip, `needs_response` is the query value: the client's
 * vocabulary is hyphenated like the rest of the UI, and the API's is snake_case like
 * the rest of its enum values. The mapping lives here so neither side has to know the
 * other's convention.
 */
const FEED_RESPONSE_PARAM: Record<EventFeedFilterId, string> = {
  upcoming: 'upcoming',
  'needs-response': 'needs_response',
  going: 'going',
  'not-going': 'not_going',
};

export interface EventFeedQueryOptions {
  filter: EventFeedFilterId;
  /** Free text matched against the title, description and venue label. */
  query?: string;
  categories?: readonly EventCategoryId[];
  limit?: number;
  offset?: number;
}

/**
 * The Events tab's list: upcoming events from the groups the member is an active
 * member of, with the response state as a filter over that one list.
 *
 * The server decides membership and visibility; the client never sends an interests
 * list, a member list or a group choice that could widen the answer. A member with no
 * groups gets an empty page, which the screen turns into "join a group" copy rather
 * than an error.
 */
export async function fetchEventFeed(options: EventFeedQueryOptions): Promise<EventPage> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(options.limit ?? EVENT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const categories = options.categories && options.categories.length > 0 ? [...options.categories] : null;

  const payload = await apiRequest<EventPagePayload>('/api/events/feed', {
    query: {
      response: FEED_RESPONSE_PARAM[options.filter],
      q: options.query?.trim() ?? '',
      category: categories?.join(',') ?? '',
      limit,
      offset,
    },
  });

  const page = payload?.page;
  const events = (page?.events ?? []).map(mapEvent).filter((event) => event.id.length > 0);
  const hasMore = page?.hasMore ?? events.length === limit;

  return {
    events,
    offset: page?.offset ?? offset,
    hasMore,
    nextOffset: page?.nextOffset ?? (hasMore ? offset + events.length : null),
  };
}

/**
 * Records an explicit answer: `going` or `not_going`.
 *
 * Deliberately separate from `cancelEventRsvp`, which *withdraws* the answer
 * altogether - the two are different states and the server keeps them apart.
 */
export async function setEventRsvp(eventId: string, status: RsvpAnswer): Promise<CampusEvent> {
  const payload = await apiRequest<{ event?: EventPayload }>(`/api/events/${eventId}/rsvp`, {
    method: 'PUT',
    body: { status },
  });
  if (!payload?.event) throw new Error('Your response could not be saved. Try again.');
  return mapEvent(payload.event);
}

/**
 * Thrown by `fetchEvent` when the event is not available to the caller.
 *
 * A distinct class so screens can tell "this answer will not change" (a private
 * group's event, a cancelled-and-removed one, an id that never existed) from "the
 * request failed" (offer a retry). The API answers 404 for all of those, so they
 * are one outcome here too.
 */
export class EventNotAvailableError extends Error {
  constructor() {
    super('That event is not available. It may have been cancelled, or it may not be shared with you.');
    this.name = 'EventNotAvailableError';
  }
}

/** One event, for the detail screen. Throws `EventNotAvailableError` on a 404. */
export async function fetchEvent(eventId: string): Promise<CampusEvent> {
  try {
    const payload = await apiRequest<{ event?: EventPayload }>(`/api/events/${eventId}`);
    if (!payload?.event) throw new EventNotAvailableError();
    return mapEvent(payload.event);
  } catch (caught) {
    if (hasApiErrorCode(caught, 'not_found')) throw new EventNotAvailableError();
    throw caught;
  }
}

/** The guest list. Readable by whoever may read the event. */
export async function fetchEventAttendees(
  eventId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<EventAttendeePage> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(options.limit ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  const payload = await apiRequest<AttendeePagePayload>(`/api/events/${eventId}/attendees`, {
    query: { limit, offset },
  });

  const page = payload?.page;
  const attendees: EventAttendee[] = (page?.attendees ?? []).map((entry) => ({
    userId: String(entry.userId ?? ''),
    displayName: String(entry.displayName ?? 'Member'),
    isYou: entry.isYou === true,
    rsvpedAt: entry.rsvpedAt ?? null,
  }));
  const hasMore = page?.hasMore ?? attendees.length === limit;

  return {
    attendees,
    offset: page?.offset ?? offset,
    hasMore,
    nextOffset: page?.nextOffset ?? (hasMore ? offset + attendees.length : null),
  };
}

/** Creates an event and returns the server's own view of it. */
export async function createEvent(body: EventBody): Promise<CampusEvent> {
  const payload = await apiRequest<{ event?: EventPayload }>('/api/events', { method: 'POST', body });
  if (!payload?.event) throw new Error('That event could not be created. Try again.');
  return mapEvent(payload.event);
}

/** Edits an event. The body is the same shape `POST /api/events` takes. */
export async function updateEvent(eventId: string, body: EventBody): Promise<CampusEvent> {
  const payload = await apiRequest<{ event?: EventPayload }>(`/api/events/${eventId}`, {
    method: 'PATCH',
    body,
  });
  if (!payload?.event) throw new Error('That event could not be saved. Try again.');
  return mapEvent(payload.event);
}

/** Cancels an event. Nothing is deleted; the API only marks it cancelled. */
export async function cancelEvent(eventId: string): Promise<CampusEvent> {
  const payload = await apiRequest<{ event?: EventPayload }>(`/api/events/${eventId}`, { method: 'DELETE' });
  if (!payload?.event) throw new Error('That event could not be cancelled. Try again.');
  return mapEvent(payload.event);
}

/** RSVPs the caller. Idempotent server-side, so a double tap is harmless. */
export async function rsvpToEvent(eventId: string): Promise<CampusEvent> {
  const payload = await apiRequest<{ event?: EventPayload }>(`/api/events/${eventId}/rsvp`, { method: 'POST' });
  if (!payload?.event) throw new Error('Your RSVP could not be saved. Try again.');
  return mapEvent(payload.event);
}

/** Cancels the caller's own RSVP. A safe no-op when there is nothing to cancel. */
export async function cancelEventRsvp(eventId: string): Promise<CampusEvent> {
  const payload = await apiRequest<{ event?: EventPayload }>(`/api/events/${eventId}/rsvp`, { method: 'DELETE' });
  if (!payload?.event) throw new Error('Your RSVP could not be cancelled. Try again.');
  return mapEvent(payload.event);
}

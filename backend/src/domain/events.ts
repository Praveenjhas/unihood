/**
 * The event vocabulary and the small rules that do not need SQL.
 *
 * The single source of truth for what an event may be: the categories, the two
 * statuses, the two RSVP states, the field limits and the page sizes. The
 * database renders the same sets as `CHECK` constraints (migration `0007`), the
 * zod schemas at the edge are built from these arrays, and the SQL in
 * `services/eventService.ts` is written against the same string literals.
 *
 * Category ids are deliberately the *group* vocabulary
 * (`domain/groups.ts` -> `GROUP_CATEGORY_IDS`). The product asks for the same
 * kinds of thing in both places ("sports and fitness", "coding and technology",
 * "food and social", ...), so one list means a member can filter groups and
 * events with the same chips and no screen has to translate between two
 * spellings. `src/types/event.ts` in the mobile app mirrors this list, exactly
 * as `domain/groups.ts` and `src/types/group.ts` already do.
 *
 * This module holds no SQL and no I/O, so the rules can be reasoned about (and
 * tested) on their own.
 */

/** The categories an event may use. Kept in step with `GROUP_CATEGORY_IDS`. */
export const EVENT_CATEGORY_IDS = [
  'sports',
  'coding',
  'study',
  'social',
  'music',
  'arts',
  'gaming',
  'travel',
  'general',
] as const;

export type EventCategoryId = (typeof EVENT_CATEGORY_IDS)[number];

/**
 * The two states an event can be in.
 *
 * `scheduled` - a live event: discoverable while it is upcoming, RSVP-able.
 * `cancelled` - taken down by its creator or a group administrator. It keeps its
 *               RSVP history, appears in no listing, refuses new RSVPs, and is
 *               only readable through its own detail endpoint so the people who
 *               were going can see why it is gone. There is no "reopen".
 */
export const EVENT_STATUSES = ['scheduled', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * The three states an RSVP can be in.
 *
 * The row is never deleted and there is at most one per (event, member), so a
 * response *moves* between these states rather than being created and destroyed:
 *
 *   `going`     - the member is attending. The only state that counts towards
 *                 capacity and the only one that appears in an attendee list.
 *   `not_going` - the member looked at the event and declined. An explicit answer,
 *                 kept apart from "no answer" so the Events feed can filter on it
 *                 and so declining does not read as withdrawing.
 *   `cancelled` - the member withdrew the RSVP they had. `cancelled_at` is set
 *                 (the schema pins that equivalence), and the member is back to
 *                 *having no answer* - which is why `cancelled` and `not_going`
 *                 are different things and why only one of them is a statement
 *                 about the event.
 *
 * Neither `not_going` nor `cancelled` ever consumes a place.
 */
export const RSVP_STATUSES = ['going', 'not_going', 'cancelled'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** The two answers a member can actively give. `cancelled` is the absence of one. */
export const RSVP_ANSWERS = ['going', 'not_going'] as const;
export type RsvpAnswer = (typeof RSVP_ANSWERS)[number];

/**
 * The four filters of the unified group-event feed.
 *
 * `upcoming` is "everything on my groups' calendars"; the other three are the
 * member's own response state. They are filters over one list, not four
 * different listings: an event never appears in `going` on one screen and in
 * `not_going` on another, because both are read from the same `event_rsvps` row.
 */
export const EVENT_FEED_FILTERS = ['upcoming', 'needs_response', 'going', 'not_going'] as const;
export type EventFeedFilter = (typeof EVENT_FEED_FILTERS)[number];


// -----------------------------------------------------------------------------
// Limits. The database CHECKs are the authority for lengths; these are what the
// mobile form counts against and what the zod schema rejects early.
// -----------------------------------------------------------------------------

export const EVENT_TITLE_MIN_LENGTH = 3;
export const EVENT_TITLE_MAX_LENGTH = 80;
export const EVENT_DESCRIPTION_MAX_LENGTH = 600;
export const EVENT_LOCATION_LABEL_MAX_LENGTH = 120;

/** An event may not run longer than this, which catches mistyped dates. */
export const EVENT_MAX_DURATION_DAYS = 30;

/** The largest capacity the API will store. */
export const MAX_EVENT_PARTICIPANTS = 10_000;

/** One page of events. Matches the People/Groups page size so paging feels the same. */
export const EVENT_PAGE_SIZE = 20;
export const MAX_EVENT_PAGE_SIZE = 50;

/** Half a page, for the attendee list. */
export const ATTENDEE_PAGE_SIZE = 25;
export const MAX_ATTENDEE_PAGE_SIZE = 100;

/** Milliseconds in a day, for the duration check above. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an event's time window is coherent, as a boolean rather than an error.
 *
 * Kept here (rather than inline in the service) so the rule is one sentence in
 * one place: an event must end after it starts and may not run for longer than
 * `EVENT_MAX_DURATION_DAYS`. Whether the *start* is in the future is a separate,
 * narrower rule that only applies when an event is created or re-timed.
 */
export function isSaneEventWindow(startAt: Date, endAt: Date): boolean {
  const start = startAt.getTime();
  const end = endAt.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (end <= start) return false;
  return end - start <= EVENT_MAX_DURATION_DAYS * DAY_MS;
}

/**
 * The event vocabulary, the API's event shape, and the pure conversions between a
 * stored event and the create/edit form.
 *
 * The category ids mirror `backend/src/domain/events.ts`, which in turn mirrors the
 * group vocabulary - one list of kinds of thing for both groups and events, so the
 * filter chips work the same way on both screens and nothing has to be translated.
 *
 * Timestamps arrive as UTC ISO strings. Every *display* helper in `src/lib/date`
 * converts them to the device's own timezone; this module only converts between the
 * wire shape and the form's local date/time text.
 */
import {
  isDateString,
  isPastInstant,
  isTimeString,
  isoFromLocal,
  toLocalDateString,
  toLocalTimeString,
} from '../lib/date';
import type { GroupAudience, GroupVisibility } from './group';

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

export interface EventCategory {
  id: EventCategoryId;
  label: string;
}

/**
 * The four filters of the Events tab.
 *
 * Since Phase 7 the tab is one *unified* feed of upcoming events belonging to the
 * groups the member is in, and these are the response-state filters over that one
 * list - not four ways of discovering events. `upcoming` is "everything my groups
 * have on"; the other three read the member's own response.
 */
export type EventFeedFilterId = 'upcoming' | 'needs-response' | 'going' | 'not-going';

export interface EventFeedFilter {
  id: EventFeedFilterId;
  label: string;
}

/** `scheduled` is a live event; `cancelled` is one that was taken down. */
export type EventStatus = 'scheduled' | 'cancelled';

/**
 * The three states of the caller's own RSVP.
 *
 *   `going`     - attending. The only state that counts towards capacity.
 *   `not_going` - an explicit "no": the member saw the event and declined.
 *   `cancelled` - the member *withdrew* an earlier RSVP, which leaves them with no
 *                 answer at all - so a withdrawn event returns to Needs response.
 */
export type RsvpStatus = 'going' | 'not_going' | 'cancelled';

/** The two answers a member can give. Withdrawing is the absence of one. */
export type RsvpAnswer = 'going' | 'not_going';

/**
 * An event as the API describes it.
 *
 * `distanceMeters` is set only by a nearby search and is `null` for an event with
 * no geographic anchor, so the UI never implies an event is within 5 km when that
 * cannot be known. The `group*` fields are `null` for a standalone event, and
 * `viewerCanManage` is the server's own answer to "may I edit or cancel this?" -
 * the client uses it to decide what to *show*, never what is allowed.
 */
export interface CampusEvent {
  id: string;
  title: string;
  description: string;
  category: EventCategoryId;
  /** UTC ISO instant; render with the `formatInstant*` helpers. */
  startAt: string;
  endAt: string;
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
  spotsLeft: number | null;
  isFull: boolean;
  status: EventStatus;
  cancelledAt: string | null;
  isPast: boolean;
  viewerRsvpStatus: RsvpStatus | null;
  viewerIsGoing: boolean;
  viewerIsCreator: boolean;
  viewerCanManage: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface EventPage {
  events: CampusEvent[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** One attendee on the guest list. Never carries an email or a coordinate. */
export interface EventAttendee {
  userId: string;
  displayName: string;
  isYou: boolean;
  rsvpedAt: string | null;
}

export interface EventAttendeePage {
  attendees: EventAttendee[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** Field limits enforced by the API, counted against by the form. */
export const EVENT_TITLE_MIN_LENGTH = 3;
export const EVENT_TITLE_MAX_LENGTH = 80;
export const EVENT_DESCRIPTION_MAX_LENGTH = 600;
export const EVENT_LOCATION_LABEL_MAX_LENGTH = 120;
export const MAX_EVENT_PARTICIPANTS = 10_000;

/** Rows per request; matches the server's page size so a page is never truncated. */
export const EVENT_PAGE_SIZE = 20;

/** A cancelled event, or one whose end time has passed, accepts no new RSVPs. */
export function isEventOpen(event: CampusEvent): boolean {
  return event.status === 'scheduled' && !event.isPast && !isPastInstant(event.endAt);
}

export function isEventCancelled(event: CampusEvent): boolean {
  return event.status === 'cancelled';
}

/** True only for `going` - the one response that occupies a place. */
export function isViewerGoing(event: CampusEvent): boolean {
  return event.viewerRsvpStatus === 'going';
}

/** True for an explicit decline. Deliberately *not* true for a withdrawn RSVP. */
export function isViewerNotGoing(event: CampusEvent): boolean {
  return event.viewerRsvpStatus === 'not_going';
}

/**
 * True when the member has an answer on file.
 *
 * A withdrawn RSVP is not an answer: it is the absence of one, which is why the
 * Needs response filter and this helper ask the same question.
 */
export function viewerHasAnswered(event: CampusEvent): boolean {
  return event.viewerRsvpStatus === 'going' || event.viewerRsvpStatus === 'not_going';
}

/** The label for the member's own response, as the detail screen shows it. */
export function viewerResponseLabel(event: CampusEvent): string {
  switch (event.viewerRsvpStatus) {
    case 'going':
      return 'Going';
    case 'not_going':
      return 'Not going';
    case 'cancelled':
      return 'You withdrew your RSVP - no answer is recorded';
    default:
      return 'No answer yet';
  }
}

/**
 * The create/edit form's own state.
 *
 * Dates and times are *local text*, because that is what a member types and what
 * the existing date helpers already speak; `eventBodyFrom` turns them into the UTC
 * instants the API stores. `maxParticipants` is text so an empty field can mean
 * "no limit" rather than zero.
 */
export interface EventFormValues {
  title: string;
  description: string;
  category: EventCategoryId;
  /** Device-local `YYYY-MM-DD`. */
  date: string;
  /** Device-local 24-hour `HH:mm`. */
  startTime: string;
  endTime: string;
  locationLabel: string;
  latitude: number | null;
  longitude: number | null;
  removeLocation: boolean;
  /** `null` means "a standalone event". */
  groupId: string | null;
  maxParticipants: string;
}

/**
 * A blank form, defaulted to a two-hour slot starting in a couple of hours.
 *
 * Late in the evening the slot moves to tomorrow morning instead, so the form never
 * opens with an end time that reads as being *before* the start on the same day.
 */
export function emptyEventFormValues(overrides: Partial<EventFormValues> = {}): EventFormValues {
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
  soon.setMinutes(0, 0, 0);
  if (soon.getHours() >= 21) {
    soon.setDate(soon.getDate() + 1);
    soon.setHours(10, 0, 0, 0);
  }
  const later = new Date(soon.getTime() + 2 * 60 * 60 * 1000);

  return {
    title: '',
    description: '',
    category: 'social',
    date: toLocalDateString(soon.toISOString()),
    startTime: toLocalTimeString(soon.toISOString()),
    endTime: toLocalTimeString(later.toISOString()),
    locationLabel: '',
    latitude: null,
    longitude: null,
    removeLocation: false,
    groupId: null,
    maxParticipants: '',
    ...overrides,
  };
}

/**
 * Seeds the edit form from a stored event, in the device's own timezone.
 *
 * The coordinates are deliberately *not* carried over: the API never returns them,
 * so "this event has an anchor" arrives as `hasLocation`. The form shows that state
 * and lets the organiser replace it with a fresh reading of the device's position -
 * which is also why `removeLocation` starts false.
 */
export function eventFormValuesFrom(event: CampusEvent): EventFormValues {
  return {
    title: event.title,
    description: event.description,
    category: event.category,
    date: toLocalDateString(event.startAt),
    startTime: toLocalTimeString(event.startAt),
    endTime: toLocalTimeString(event.endAt),
    locationLabel: event.locationLabel ?? '',
    latitude: null,
    longitude: null,
    removeLocation: false,
    groupId: event.groupId,
    maxParticipants: event.maxParticipants === null ? '' : String(event.maxParticipants),
  };
}

/** The body `POST /api/events` and `PATCH /api/events/:id` accept. */
export interface EventBody {
  title: string;
  description: string;
  category: EventCategoryId;
  startAt: string;
  endAt: string;
  locationLabel: string | null;
  latitude?: number | null;
  longitude?: number | null;
  removeLocation?: boolean;
  groupId?: string | null;
  maxParticipants: number | null;
}

/** Why the form cannot be submitted yet, or `null` when it can. */
export function eventFormProblem(
  values: EventFormValues,
  options: { requireGroup?: boolean } = {},
): string | null {
  if (values.title.trim().length < EVENT_TITLE_MIN_LENGTH) {
    return `Give the event a title of at least ${EVENT_TITLE_MIN_LENGTH} characters.`;
  }
  if (values.title.trim().length > EVENT_TITLE_MAX_LENGTH) {
    return `Keep the title to ${EVENT_TITLE_MAX_LENGTH} characters or fewer.`;
  }
  if (values.description.trim().length === 0) {
    return 'Add a short description so people know what to expect.';
  }
  // Phase 7: an event created from the Events tab belongs to one of the member's
  // groups, so the group is a required field there. The API still accepts a
  // standalone body for compatibility, which is why this is a form rule rather than
  // a server rule.
  if (options.requireGroup === true && values.groupId === null) {
    return 'Choose the group that is hosting this event.';
  }
  if (!isDateString(values.date)) return 'Use a date like 2026-10-10.';
  if (!isTimeString(values.startTime) || !isTimeString(values.endTime)) {
    return 'Use times like 18:00 and 20:30.';
  }

  const start = isoFromLocal(values.date, values.startTime);
  const end = isoFromLocal(values.date, values.endTime);
  if (!start || !end) return 'That date and time could not be read.';
  if (Date.parse(end) <= Date.parse(start)) return 'The end time has to be after the start time.';

  const limit = values.maxParticipants.trim();
  if (limit.length > 0) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_EVENT_PARTICIPANTS) {
      return `A participant limit must be a whole number between 1 and ${MAX_EVENT_PARTICIPANTS}, or left blank.`;
    }
  }

  if (values.latitude !== null && values.longitude === null) return 'That venue location is incomplete.';
  return null;
}

/**
 * The API body for a form, or `null` while the date and time are still unreadable.
 *
 * The anchor is passed through only when the form actually holds one, so an edit
 * that never touched the location leaves the stored point alone; `removeLocation`
 * is the explicit way to ask for it to be dropped. `includeGroup` is false on an
 * edit because an event does not move between groups.
 */
export function eventBodyFrom(values: EventFormValues, options: { includeGroup: boolean }): EventBody | null {
  const startAt = isoFromLocal(values.date, values.startTime);
  const endAt = isoFromLocal(values.date, values.endTime);
  if (!startAt || !endAt) return null;

  const limit = values.maxParticipants.trim();
  const label = values.locationLabel.trim();

  const body: EventBody = {
    title: values.title.trim(),
    description: values.description.trim(),
    category: values.category,
    startAt,
    endAt,
    locationLabel: label.length > 0 ? label : null,
    maxParticipants: limit.length > 0 ? Number(limit) : null,
  };

  if (values.latitude !== null && values.longitude !== null) {
    body.latitude = values.latitude;
    body.longitude = values.longitude;
  } else if (values.removeLocation) {
    body.removeLocation = true;
  }

  if (options.includeGroup) body.groupId = values.groupId;

  return body;
}

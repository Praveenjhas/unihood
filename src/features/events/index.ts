/**
 * Events feature — the API-backed repository, the shared form, the card and the
 * date block.
 *
 * There is no mock catalogue any more: every event here is a row in MySQL, and the
 * Phase 1 catalogue was deleted with the screens that read it.
 */
export { EventCard, type EventCardProps } from './EventCard';
export { EventDateBlock, type EventDateBlockProps } from './EventDateBlock';
export { EventForm, type EventFormProps } from './EventForm';
export {
  EventNotAvailableError,
  cancelEvent,
  cancelEventRsvp,
  createEvent,
  fetchEvent,
  fetchEventAttendees,
  fetchEventFeed,
  fetchEventsPage,
  rsvpToEvent,
  setEventRsvp,
  updateEvent,
  type EventFeedQueryOptions,
  type EventListMode,
  type EventQueryOptions,
} from './eventRepo';

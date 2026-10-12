import {
  EVENT_CATEGORY_IDS,
  type EventCategory,
  type EventCategoryId,
  type EventFeedFilter,
  type EventFeedFilterId,
} from '../types';

/**
 * The event vocabulary, as labels.
 *
 * Ids are the server's (`backend/src/domain/events.ts`) and they are deliberately
 * the *same* ids the Groups filter uses, so one chip row means the same thing on
 * both screens. The labels are the app's.
 */
const EVENT_CATEGORY_LABELS: Record<EventCategoryId, string> = {
  sports: 'Sports & fitness',
  coding: 'Coding & tech',
  study: 'Study',
  social: 'Food & social',
  music: 'Music',
  arts: 'Arts & design',
  gaming: 'Gaming',
  travel: 'Travel & outdoors',
  general: 'General',
};

export const EVENT_CATEGORIES: readonly EventCategory[] = EVENT_CATEGORY_IDS.map((id) => ({
  id,
  label: EVENT_CATEGORY_LABELS[id],
}));

export function eventCategoryLabel(id: EventCategoryId): string {
  return EVENT_CATEGORY_LABELS[id];
}

/**
 * The Events tab's four filters, as labels.
 *
 * The ids are what `/api/events/feed?response=` accepts, so the chip the member taps
 * and the query the API runs are the same word.
 */
export const EVENT_FEED_FILTERS: readonly EventFeedFilter[] = [
  { id: 'upcoming', label: 'All upcoming' },
  { id: 'needs-response', label: 'Needs response' },
  { id: 'going', label: 'Going' },
  { id: 'not-going', label: 'Not going' },
];

const EVENT_FEED_FILTER_LABELS: Record<EventFeedFilterId, string> = {
  upcoming: 'All upcoming',
  'needs-response': 'Needs response',
  going: 'Going',
  'not-going': 'Not going',
};

export function eventFeedFilterLabel(id: EventFeedFilterId): string {
  return EVENT_FEED_FILTER_LABELS[id];
}

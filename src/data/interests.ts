import { INTEREST_IDS, isInterestId, type Interest, type InterestId } from '../types';

/**
 * Display labels for the shared interest vocabulary.
 *
 * Typing this as a `Record<InterestId, string>` makes the compiler the guard
 * rail: adding an id to `INTEREST_IDS` without a label here is a build error,
 * so filter chips and tags can never silently lose an interest.
 */
const INTEREST_LABELS: Record<InterestId, string> = {
  sports: 'Sports',
  coding: 'Coding',
  music: 'Music',
  movies: 'Film & TV',
  study: 'Study',
  art: 'Art & Design',
  food: 'Food',
  gaming: 'Gaming',
  travel: 'Travel',
  volunteering: 'Volunteering',
};

/** Ordered catalog used by the Phase 1 mock catalogs (Groups, Events). */
export const INTERESTS: readonly Interest[] = INTEREST_IDS.map((id) => ({
  id,
  label: INTEREST_LABELS[id],
}));

export function interestLabel(id: InterestId): string {
  return INTEREST_LABELS[id];
}

/**
 * Labels for interest ids that exist in the database seed but not in the Phase 1
 * mock vocabulary. They exist so a *live* interest can still be rendered when
 * the catalog request has not resolved (or failed) — the catalog remains the
 * source of truth, this is only the fallback.
 */
const DATABASE_ONLY_LABELS: Readonly<Record<string, string>> = {
  fitness: 'Fitness',
  reading: 'Reading',
  photography: 'Photography',
};

/**
 * Label for any interest id, from any source.
 *
 * Unknown ids degrade to a title-cased version of the id instead of throwing or
 * showing a raw slug: a vocabulary that grows server-side must never break the
 * rendering of a card.
 */
export function interestLabelFor(id: string): string {
  if (isInterestId(id)) return INTEREST_LABELS[id];
  if (id in DATABASE_ONLY_LABELS) return DATABASE_ONLY_LABELS[id];
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

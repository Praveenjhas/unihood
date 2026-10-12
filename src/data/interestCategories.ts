/**
 * The interest catalogue's groups.
 *
 * The database owns the *membership* of each interest (`interests.category`), and
 * this module owns how those groups read and in what order they appear. Both
 * halves are needed: the server cannot know that "Outdoors and gardening" should
 * come before "Gaming" on a phone screen, and the app cannot know which ids it has
 * not seen yet.
 *
 * The ids are the CHECK values from migration 0009. A group the app does not know
 * (a category added server-side later) still renders - `interestCategoryLabel`
 * title-cases the slug and `interestCategoryRank` sorts it last - because the
 * vocabulary growing must never blank a chip.
 */
import type { Interest } from '../types';

export const INTEREST_CATEGORY_IDS = [
  'exams_career',
  'programming_tech',
  'education_study',
  'sports_fitness',
  'outdoors_gardening',
  'movies_entertainment',
  'music_performing',
  'books_writing',
  'food_cooking',
  'travel_exploration',
  'gaming',
  'photography_crafts',
  'entrepreneurship',
  'languages_culture',
  'general_social',
] as const;

export type InterestCategoryId = (typeof INTEREST_CATEGORY_IDS)[number];

const CATEGORY_LABELS: Record<InterestCategoryId, string> = {
  exams_career: 'Exams & career',
  programming_tech: 'Programming & tech',
  education_study: 'Education & study',
  sports_fitness: 'Sports & fitness',
  outdoors_gardening: 'Outdoors & gardening',
  movies_entertainment: 'Movies & entertainment',
  music_performing: 'Music & performing arts',
  books_writing: 'Books & writing',
  food_cooking: 'Food & cooking',
  travel_exploration: 'Travel & exploration',
  gaming: 'Gaming',
  photography_crafts: 'Photography & crafts',
  entrepreneurship: 'Entrepreneurship',
  languages_culture: 'Languages & culture',
  general_social: 'General social',
};

/** Where an interest with no category (or an unknown one) is grouped. */
export const FALLBACK_INTEREST_CATEGORY = 'general_social';

/** The group an interest belongs to, as a renderable id. */
export function interestCategoryOf(interest: Pick<Interest, 'category'>): string {
  return typeof interest.category === 'string' && interest.category.trim().length > 0
    ? interest.category.trim()
    : FALLBACK_INTEREST_CATEGORY;
}

/** Heading text for a category id, title-casing anything the app has not seen. */
export function interestCategoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category as InterestCategoryId];
  if (known) return known;
  return category
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

/** Position in the curated reading order; unknown categories sort last. */
export function interestCategoryRank(category: string): number {
  const index = (INTEREST_CATEGORY_IDS as readonly string[]).indexOf(category);
  return index === -1 ? INTEREST_CATEGORY_IDS.length : index;
}

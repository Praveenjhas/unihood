/**
 * Interests are the shared vocabulary between members, groups and the People
 * discovery filters.
 *
 * Two layers exist, on purpose:
 *
 * - `InterestId` is a *compile-time* union covering the ids the in-app mock
 *   catalogs (Groups, Events) reference. The compiler can then prove that every
 *   mock row carries a label.
 * - `Interest.id` is a plain `string`, because the live vocabulary is owned by
 *   the `public.interests` table and can grow without a client release. The
 *   Phase 2 seed contains these ids plus `fitness`, `reading` and
 *   `photography` (see `backend/migrations/0002_interests.sql`).
 *
 * The overlap is intentional: mock rows and database rows describe the same
 * subject areas, so a filter chip means the same thing in both worlds.
 */
export const INTEREST_IDS = [
  'sports',
  'coding',
  'music',
  'movies',
  'study',
  'art',
  'food',
  'gaming',
  'travel',
  'volunteering',
] as const;

export type InterestId = (typeof INTEREST_IDS)[number];

/** A selectable interest, used by filter chips and interest tags. */
export interface Interest {
  /** Matches `public.interests.id`; never client-generated. */
  id: string;
  label: string;
  /**
   * The catalogue group this interest belongs to (`programming_tech`, …).
   *
   * Optional because the compiled fallback vocabulary predates the catalogue and
   * because an id added server-side must never fail to render: the picker treats a
   * missing value as "Other" rather than dropping the chip.
   */
  category?: string | null;
}

/** Narrowing helper for data that arrives from an untyped source. */
export function isInterestId(value: string): value is InterestId {
  return (INTEREST_IDS as readonly string[]).includes(value);
}

/** Deduplicates and drops blanks from a list of interest ids from any source. */
export function normalizeInterestIds(ids: readonly string[] | null | undefined): string[] {
  if (!ids || ids.length === 0) return [];
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort();
}

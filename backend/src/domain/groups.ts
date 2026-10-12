/**
 * The group vocabulary and the eligibility rule.
 *
 * The single source of truth for what a group may be: the categories, the two
 * visibilities, the three audiences and the five membership states. The database
 * renders the same sets as `CHECK` constraints (migration `0006`), the zod
 * schemas at the edge are built from these arrays, and the SQL in
 * `services/groupService.ts` is written against the same string literals.
 *
 * `src/types/group.ts` in the mobile app mirrors the category list; keep the two
 * in step, exactly as `domain/geo.ts` and `src/lib/geo.ts` already are.
 *
 * This module holds no SQL and no I/O, so the rules can be reasoned about (and
 * tested) on their own.
 */

export const GROUP_CATEGORY_IDS = [
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

export type GroupCategoryId = (typeof GROUP_CATEGORY_IDS)[number];

export const GROUP_VISIBILITIES = ['public', 'private'] as const;
export type GroupVisibility = (typeof GROUP_VISIBILITIES)[number];

/**
 * Who a group is for.
 *
 * `everyone` accepts any eligible member; the two restricted values accept only a
 * member whose own, private eligibility setting matches. Audiences are a filter on
 * *membership and discovery*, never a statement the server makes about anyone:
 * a member's value is self-declared and is never returned in a public payload.
 */
export const GROUP_AUDIENCES = ['everyone', 'men_only', 'women_only'] as const;
export type GroupAudience = (typeof GROUP_AUDIENCES)[number];

/**
 * The self-declared eligibility values a member can set on their own profile.
 *
 * `another` and `prefer_not_to_say` are deliberately not equivalent to NULL:
 * NULL means "never asked", and the settings screen must be able to show a member
 * what they actually chose.
 */
export const GROUP_ELIGIBILITY_VALUES = ['man', 'woman', 'another', 'prefer_not_to_say'] as const;
export type GroupEligibility = (typeof GROUP_ELIGIBILITY_VALUES)[number];

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * The five states a membership can be in.
 *
 * `pending`  - requested, not yet decided (private groups only).
 * `active`   - a member. `joined_at` is set (the schema enforces this).
 * `rejected` - a request was declined. Terminal until an administrator decides
 *              otherwise; there is no re-open endpoint in this phase, which is
 *              the documented re-entry rule (see `joinGroup`).
 * `left`     - left voluntarily, or withdrew a pending request. Re-entry allowed.
 * `removed`  - removed by an owner or administrator. Terminal, like `rejected`.
 */
export const MEMBERSHIP_STATUSES = ['pending', 'active', 'rejected', 'left', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** A membership is only ever *decided* on these transitions. */
export const DECIDED_STATUSES: readonly MembershipStatus[] = ['active', 'rejected', 'removed'];

// -----------------------------------------------------------------------------
// Limits. The database CHECKs are the authority for lengths; these are what the
// mobile form counts against and what the zod schema rejects early.
// -----------------------------------------------------------------------------

export const GROUP_NAME_MIN_LENGTH = 3;
export const GROUP_NAME_MAX_LENGTH = 60;
export const GROUP_DESCRIPTION_MAX_LENGTH = 280;
export const GROUP_LOCATION_LABEL_MAX_LENGTH = 80;

/**
 * The most interest ids one discovery filter may name at once.
 *
 * The same bound `peopleService` uses, for the same reason: enough for the chips
 * the viewer actually selected, small enough that a single request cannot ask the
 * database to match the whole catalogue.
 */
export const MAX_GROUP_INTEREST_FILTERS = 20;

/** One page of groups. Matches the People page size so paging feels the same. */
export const GROUP_PAGE_SIZE = 20;
export const MAX_GROUP_PAGE_SIZE = 50;

/** Half of a page, for the two management lists. */
export const MEMBERSHIP_PAGE_SIZE = 25;
export const MAX_MEMBERSHIP_PAGE_SIZE = 100;

/**
 * The eligibility value an audience requires, or `null` when it accepts everyone.
 *
 * `everyone` is the default everywhere - in the form, in the API schema and in
 * the database - so a member is never filtered by a field they did not set.
 */
export function requiredEligibilityFor(audience: GroupAudience): GroupEligibility | null {
  switch (audience) {
    case 'men_only':
      return 'man';
    case 'women_only':
      return 'woman';
    case 'everyone':
      return null;
  }
}

/**
 * Whether a member may discover and join a group with this audience.
 *
 * A missing setting (NULL / `null`) fails a restricted audience on purpose: the
 * member has not told us anything, so the server cannot claim they qualify. The
 * client answers that with `audience_not_eligible`, which the UI turns into a
 * pointer at the eligibility setting rather than a dead end.
 */
export function isEligibleForAudience(
  audience: GroupAudience,
  eligibility: GroupEligibility | null,
): boolean {
  const required = requiredEligibilityFor(audience);
  if (required === null) return true;
  return eligibility === required;
}

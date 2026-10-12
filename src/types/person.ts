/**
 * A member as returned by discovery (`search_people` / `nearby_people` /
 * `get_public_profile`).
 *
 * This is the *public projection* of a profile and it is deliberately narrower
 * than `Profile`: it carries no email, no privacy switches and — most
 * importantly — no coordinates. `distanceMeters` is an approximate figure that
 * the database only produces when both sides consented to nearby discovery and
 * both have a saved area; otherwise it is `null`, which the UI must render as
 * "distance unavailable" rather than as zero.
 */
export interface Person {
  id: string;
  displayName: string;
  bio: string | null;
  avatarPath: string | null;
  locationLabel: string | null;
  /** The candidate's interests, as ids (labels come from the interest catalog). */
  interestIds: string[];
  /**
   * The interests the viewer also picked, as ids.
   *
   * Computed by the API from both sides' stored interests, so it is the ranking's
   * own answer rather than a client-side guess that could disagree with the order
   * the list arrived in. Empty when there is nothing in common - or on an older
   * response, which is why the cards fall back to comparing ids themselves.
   */
  sharedInterestIds: string[];
  /** How many interests the viewer also picked; the primary ranking signal. */
  sharedInterestCount: number;
  /** Approximate metres away, or `null` when the distance cannot be shared. */
  distanceMeters: number | null;
}

/**
 * One page of discovery results.
 *
 * The endpoint is offset-paged and capped at 50 rows per call: `hasMore` is derived
 * from a full page coming back, and `nextOffset` is what the "load more" control
 * sends next. `total` is intentionally absent — a count over every profile is
 * both expensive and a privacy leak.
 */
export interface PersonPage {
  people: Person[];
  /** Offset to request next; `null` when there is nothing more to load. */
  nextOffset: number | null;
  hasMore: boolean;
  /** Offset this page started at, so screens can replace-render correctly. */
  offset: number;
}

/**
 * Which of the two things a search term is compared against.
 *
 * The People screen is a nearby search with two segments: **Name** matches the
 * display name, **Skill** matches the interest labels and slugs a member picked.
 * One field, two questions - and the segment is what decides which one the server
 * answers, so a name search never floods the list with interest matches.
 *
 * Geography is not part of this: every People result is measured from the member's
 * own saved nearby area, so there is no "everyone, everywhere" mode to return to.
 */
export type PeopleSearchField = 'name' | 'skill';

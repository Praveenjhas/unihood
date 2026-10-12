/**
 * Discovery data access.
 *
 * One endpoint, two modes: `GET /api/people?mode=search|nearby&by=name|skill|any`
 * returns the same public projection either way. The app always asks for
 * `mode=nearby` (geography is always applied), while `mode=search` is kept for
 * callers that want a name/skill answer with no radius at all. `by` says which of
 * the two segments - Name or Skill - the member is in, so `q` is matched against
 * the display name, or against interest labels and slugs, and never against both
 * at once.
 *
 * Privacy note for callers: `distanceMeters` is `null` unless *both* sides
 * consented to nearby discovery and both hold a saved nearby area. The UI must
 * render that as "distance unavailable", never as zero.
 *
 * `matchSharedInterests` is Phase 6's interest *match* - a server-side filter that
 * keeps only members who share an interest with the viewer - and every row carries
 * `sharedInterestIds`, the ids that actually overlapped, so the card can tint the
 * right chips rather than re-deriving them from a possibly stale profile.
 */
import { DEFAULT_RADIUS_METERS, apiRequest, clampRadiusMeters, hasApiErrorCode } from '../../lib';
import { normalizeInterestIds, type Person, type PersonPage, type PeopleSearchField } from '../../types';

/** Rows per request. Matches the server-side page size, so a page is never truncated. */
export const PEOPLE_PAGE_SIZE = 20;

/** The largest page the API accepts. */
const MAX_PAGE_SIZE = 50;

/** One row of the people list, as the API sends it. */
interface PersonPayload {
  id: string;
  displayName: string;
  bio: string | null;
  avatarPath: string | null;
  locationLabel: string | null;
  interestIds?: string[] | null;
  sharedInterestIds?: string[] | null;
  sharedInterestCount?: number | null;
  distanceMeters?: number | null;
}

interface PeoplePagePayload {
  page?: {
    people?: PersonPayload[] | null;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  };
}

export interface DiscoveryOptions {
  /** Which segment the member is in: `name` matches the name, `skill` the skills. */
  searchField?: PeopleSearchField;
  /** Free text; `by` decides what it is compared against. */
  query?: string;
  /** Interest ids to filter by; an empty list means "no filter". */
  interestIds?: readonly string[];
  /**
   * Keep only members who share at least one interest with the viewer.
   *
   * Server-side, because it is computed from the viewer's *stored* interests: the
   * screen does not send its own list, so the filter cannot be widened by a client.
   */
  matchSharedInterests?: boolean;
  /** Clamped to the server's 1-10 km window; geography is always applied. */
  radiusMeters?: number;
  limit?: number;
  offset?: number;
}

function mapPerson(payload: PersonPayload): Person {
  return {
    id: payload.id,
    displayName: payload.displayName,
    bio: payload.bio,
    avatarPath: payload.avatarPath,
    locationLabel: payload.locationLabel,
    interestIds: normalizeInterestIds(payload.interestIds ?? []),
    sharedInterestIds: normalizeInterestIds(payload.sharedInterestIds ?? []),
    sharedInterestCount: payload.sharedInterestCount ?? 0,
    distanceMeters: payload.distanceMeters ?? null,
  };
}

/**
 * One page of discovery results.
 *
 * The server reports `hasMore` and the next offset; the local fallbacks keep a
 * short page from looking like the end of the list if a future response omits
 * them.
 */
/**
 * The one mode this app asks for.
 *
 * People has no way to fall back to "everyone on Unihood": the search is a nearby
 * search by definition, so a member without a saved area is offered the way to set
 * one instead of a list of strangers. `mode=search` still exists server-side for
 * callers that want no radius at all - the app simply never uses it.
 */
const DISCOVERY_MODE = 'nearby' as const;

export async function fetchPeoplePage(options: DiscoveryOptions): Promise<PersonPage> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(options.limit ?? PEOPLE_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const interestIds = options.interestIds && options.interestIds.length > 0 ? [...options.interestIds] : null;

  const payload = await apiRequest<PeoplePagePayload>('/api/people', {
    query: {
      mode: DISCOVERY_MODE,
      by: options.searchField ?? 'name',
      q: options.query?.trim() ?? '',
      interests: interestIds?.join(',') ?? '',
      matched: options.matchSharedInterests ? 'true' : 'false',
      radius: clampRadiusMeters(options.radiusMeters ?? DEFAULT_RADIUS_METERS),
      limit,
      offset,
    },
  });

  const page = payload?.page;
  const people = (page?.people ?? []).map(mapPerson);
  const hasMore = page?.hasMore ?? people.length === limit;

  return {
    people,
    offset: page?.offset ?? offset,
    hasMore,
    nextOffset: page?.nextOffset ?? (hasMore ? offset + people.length : null),
  };
}

/**
 * Thrown by `fetchPerson` when the member is not visible to the viewer.
 *
 * A distinct class so screens can tell "this answer will not change" (they
 * turned sharing off, or the id never existed) from "the request failed" (offer
 * a retry). The API answers 404 for both cases, so they are one outcome here too.
 */
export class PersonNotAvailableError extends Error {
  constructor() {
    super('That profile is not shared anymore. It may have been made private.');
    this.name = 'PersonNotAvailableError';
  }
}

/**
 * One member's public profile, for the person detail screen.
 *
 * Throws `PersonNotAvailableError` when the member is not discoverable.
 */
export async function fetchPerson(profileId: string): Promise<Person> {
  try {
    const payload = await apiRequest<{ person?: PersonPayload }>(`/api/people/${profileId}`);
    if (!payload?.person) throw new PersonNotAvailableError();
    return mapPerson(payload.person);
  } catch (caught) {
    if (hasApiErrorCode(caught, 'not_found')) throw new PersonNotAvailableError();
    throw caught;
  }
}

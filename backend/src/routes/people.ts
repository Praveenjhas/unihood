/**
 * People discovery.
 *
 *   GET /api/people?mode=search|nearby&by=name|skill|any&q=&interests=a,b&matched=true&radius=5000&limit=20&offset=0
 *        -> { page: { people, offset, hasMore, nextOffset } }
 *   GET /api/people/:id -> { person }
 *
 * One endpoint for both modes rather than two, because the response is identical
 * either way - which is exactly the contract the two Supabase RPCs provided.
 * `mode=nearby` adds a radius test around the caller's own stored area; the app
 * always sends it, and `mode=search` remains for callers that want the same
 * filters with no geography.
 *
 * `by` picks what `q` is compared against, because the screen has two segments:
 * `name` matches the display name, `skill` matches the labels and slugs of the
 * interests a member picked. `any` - the default - matches both, which is the
 * behaviour a caller that only sends `q` already relied on.
 *
 * `matched=true` is Phase 6's interest *match*: the service keeps only members who
 * share at least one interest with the caller, reading the caller's own interests
 * from the database. It is deliberately a separate switch from `interests=`, which
 * is a plain filter on what the candidate picked.
 */
import { Router } from 'express';
import { z } from 'zod';

import { DEFAULT_RADIUS_METERS, MAX_RADIUS_METERS } from '../domain/geo';
import { parseParams, parseQuery } from '../http/validate';
import { asyncHandler } from '../lib/asyncHandler';
import { getAuth, requireAuth } from '../middleware/requireAuth';
import {
  MAX_PEOPLE_PAGE_SIZE,
  PEOPLE_PAGE_SIZE,
  getPublicProfile,
  nearbyPeople,
  searchPeople,
} from '../services/peopleService';

export const peopleRouter = Router();

const discoveryQuerySchema = z.object({
  mode: z.enum(['search', 'nearby']).default('search'),
  /**
   * What `q` may be compared against: the display name, an interest label/slug, or
   * both. An enum rather than free text, so an unknown value cannot silently widen
   * the search back to "everything".
   */
  by: z.enum(['name', 'skill', 'any']).default('any'),
  /**
   * Free text. What it matches is decided by `by`: Name compares it with the
   * display name, Skill with the interests the member picked (label or slug, so
   * "machine learning" finds `machine_learning`), and the default `any` with
   * either.
   */
  q: z.string().max(80).optional(),
  /** Comma-separated interest ids; the service rejects an over-long list. */
  interests: z.string().max(600).optional(),
  /**
   * `true` = only members who share at least one interest with the caller.
   *
   * The two literals rather than `z.coerce.boolean()`: a query string is always
   * text, and `Boolean('0')` is `true`.
   */
  matched: z.enum(['true', 'false']).default('false'),
  radius: z.coerce.number().int().min(0).max(MAX_RADIUS_METERS * 10).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PEOPLE_PAGE_SIZE).default(PEOPLE_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const personParamsSchema = z.object({
  id: z.string().uuid('That profile link is not valid.'),
});

/** `a,b,,c` -> `['a','b','c']`; blanks are dropped rather than rejected. */
function splitInterestIds(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

peopleRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(discoveryQuerySchema, request);
    const callerId = getAuth(request).userId;

    const options = {
      query: query.q ?? '',
      searchField: query.by,
      interestIds: splitInterestIds(query.interests),
      matchSharedInterests: query.matched === 'true',
      limit: query.limit,
      offset: query.offset,
    };

    const page =
      query.mode === 'nearby'
        ? await nearbyPeople(callerId, { ...options, radiusMeters: query.radius ?? DEFAULT_RADIUS_METERS })
        : await searchPeople(callerId, options);

    response.json({ page });
  }),
);

peopleRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(personParamsSchema, request);

    const person = await getPublicProfile(getAuth(request).userId, params.id);
    response.json({ person });
  }),
);

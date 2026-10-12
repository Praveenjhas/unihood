/**
 * Groups.
 *
 *   GET    /api/groups?q=&category=&interest=&matched=&visibility=&limit=&offset=
 *          -> { page: { groups, offset, hasMore, nextOffset } }
 *   GET    /api/groups/nearby?q=&category=&interest=&matched=&radius=&limit=&offset=
 *          -> { page: { groups, offset, hasMore, nextOffset } }   (distanceMeters set,
 *             interest matches ranked before distance)
 *   GET    /api/groups/mine?limit=&offset=
 *          -> { page: { groups, offset, hasMore, nextOffset } }
 *   GET    /api/groups/:id                 -> { group }
 *   POST   /api/groups                     -> 201 { group }
 *   PATCH  /api/groups/:id                 -> { group }
 *   DELETE /api/groups/:id                 -> 204 (archive)
 *   POST   /api/groups/:id/join            -> { group }   (active, or pending for a private group)
 *   POST   /api/groups/:id/leave           -> { group }
 *   POST   /api/groups/:id/join-request/cancel -> { group }
 *   GET    /api/groups/:id/members?limit=&offset=      -> { page: { members, … } }
 *   GET    /api/groups/:id/join-requests?limit=&offset= -> { page: { requests, … } }
 *   POST   /api/groups/:id/join-requests/:userId/approve -> { request }
 *   POST   /api/groups/:id/join-requests/:userId/reject  -> { request }
 *   PATCH  /api/groups/:id/members/:userId              -> { member }
 *   DELETE /api/groups/:id/members/:userId              -> 204
 *   GET    /api/groups/:id/messages?limit=&before=      -> { page: { messages, hasMore, nextCursor } }
 *   POST   /api/groups/:id/messages                     -> 201 { message }
 *
 * `/nearby` and `/mine` are declared before `/:id` on purpose: Express matches in
 * declaration order, so a literal segment registered late would be swallowed by the
 * id parameter.
 *
 * The two chat endpoints (Phase 7) are for active members only, and the membership
 * check lives in `services/chatService.ts` next to the SQL - the router never decides
 * who may read or post, it only parses. `POST` spends the member's message budget
 * first (`middleware/messageLimit.ts`), which is the *same* allowance the socket's
 * `message:send` spends, so neither transport can be used to buy more.
 *
 * Every mutation refreshes the group and returns it, so the client never invents a
 * post-action state. The zod schemas here deliberately check *types and shapes*
 * only: lengths, the audience rule and every authorization decision are enforced in
 * `services/groupService.ts`, next to the SQL, where the API and the database cannot
 * disagree.
 */
import { Router } from 'express';
import { z } from 'zod';

import { DEFAULT_RADIUS_METERS, MAX_RADIUS_METERS } from '../domain/geo';
import { MAX_MESSAGE_PAGE_SIZE, MESSAGE_MAX_LENGTH, MESSAGE_PAGE_SIZE } from '../domain/chat';
import {
  GROUP_AUDIENCES,
  GROUP_CATEGORY_IDS,
  GROUP_PAGE_SIZE,
  GROUP_VISIBILITIES,
  MAX_GROUP_INTEREST_FILTERS,
  MAX_GROUP_PAGE_SIZE,
  MAX_MEMBERSHIP_PAGE_SIZE,
  MEMBERSHIP_PAGE_SIZE,
  type GroupAudience,
  type GroupCategoryId,
  type GroupVisibility,
} from '../domain/groups';
import { parseBody, parseParams, parseQuery } from '../http/validate';
import { asyncHandler } from '../lib/asyncHandler';
import { messageLimiter } from '../middleware/messageLimit';
import { getAuth, requireAuth } from '../middleware/requireAuth';
import { listGroupMessages, sendGroupMessage } from '../services/chatService';
import {
  approveJoinRequest,
  archiveGroup,
  cancelJoinRequest,
  createGroup,
  getGroup,
  joinGroup,
  leaveGroup,
  listGroups,
  listJoinRequests,
  listMembers,
  listMyGroups,
  listNearbyGroups,
  rejectJoinRequest,
  removeMember,
  setMemberRole,
  updateGroup,
  type GroupDraft,
} from '../services/groupService';

export const groupsRouter = Router();

const groupIdParamsSchema = z.object({
  id: z.string().uuid('That group link is not valid.'),
});

const memberParamsSchema = z.object({
  id: z.string().uuid('That group link is not valid.'),
  userId: z.string().uuid('That member link is not valid.'),
});

const listQuerySchema = z.object({
  q: z.string().max(120).optional(),
  /** Comma-separated category ids; the same shape the interest filter uses. */
  category: z.string().max(200).optional(),
  /** Comma-separated interest ids, matched against the group's primary interest. */
  interest: z.string().max(600).optional(),
  /**
   * `true` = only groups whose primary interest the caller also picked.
   *
   * An enum of the two literals rather than `z.coerce.boolean()`, because a query
   * string is always text and `Boolean('0')` is `true` - the one coercion that
   * would silently turn "off" into "on".
   */
  matched: z.enum(['true', 'false']).default('false'),
  visibility: z.enum(GROUP_VISIBILITIES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_GROUP_PAGE_SIZE).default(GROUP_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** `a,b,,c` -> `['a','b','c']`, keeping only ids the vocabulary knows. */
function splitCategories(value: string | undefined): GroupCategoryId[] {
  if (!value) return [];
  const known = new Set<string>(GROUP_CATEGORY_IDS);
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => known.has(entry)) as GroupCategoryId[];
}

/**
 * `a,b,,c` -> `['a','b','c']`, de-duplicated and capped.
 *
 * Ids are deliberately *not* checked against the catalogue here: an unknown id
 * matches nothing, which is the honest answer for a filter, and the vocabulary
 * lives in `interests` rather than in an array this file could drift away from.
 * The cap is the shared bound the service documents, so a stale client sending too
 * many chips still gets a page instead of an error.
 */
function splitInterestIds(value: string | undefined): string[] {
  if (!value) return [];

  const unique = new Set<string>();
  for (const entry of value.split(',')) {
    const id = entry.trim();
    if (id.length > 0) unique.add(id);
  }

  return [...unique].slice(0, MAX_GROUP_INTEREST_FILTERS);
}

/**
 * The radius is accepted generously and clamped by the service to the shared
 * 1-10 km window, exactly as the People search does: a client asking for a silly
 * radius gets a sane answer rather than a 400.
 */
const nearbyQuerySchema = listQuerySchema.extend({
  radius: z.coerce.number().int().min(0).max(MAX_RADIUS_METERS * 10).optional(),
});

const membershipQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_MEMBERSHIP_PAGE_SIZE).default(MEMBERSHIP_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/**
 * Generous upper bounds - the real limits are smaller and are reported with
 * member-facing wording by the service. These exist so an oversized payload cannot
 * reach the service at all.
 */
const groupDraftSchema = z.object({
  name: z.string().max(400),
  description: z.string().max(2000),
  category: z.enum(GROUP_CATEGORY_IDS),
  /**
   * The group's primary interest. Generous bound here; the service checks it
   * against the catalogue so the error names the field rather than the constraint.
   */
  interestId: z.string().max(64).nullish(),
  visibility: z.enum(GROUP_VISIBILITIES).default('public'),
  audience: z.enum(GROUP_AUDIENCES).default('everyone'),
  locationLabel: z.string().max(400).nullish(),
  latitude: z.number().finite('Latitude must be a number.').nullish(),
  longitude: z.number().finite('Longitude must be a number.').nullish(),
  removeLocation: z.boolean().optional(),
});

const groupPatchSchema = groupDraftSchema.partial();

const memberRoleSchema = z.object({
  // `owner` is not offered: there is no ownership transfer in this phase.
  role: z.enum(['admin', 'member']),
});

/** Turns a parsed draft into the service's input shape. */
function toDraft(body: z.infer<typeof groupDraftSchema>): GroupDraft {
  return {
    name: body.name,
    description: body.description,
    category: body.category as GroupCategoryId,
    interestId: body.interestId ?? null,
    visibility: body.visibility as GroupVisibility,
    audience: body.audience as GroupAudience,
    locationLabel: body.locationLabel ?? null,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    removeLocation: body.removeLocation === true,
  };
}

// -----------------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------------

groupsRouter.get(
  '/nearby',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(nearbyQuerySchema, request);
    const callerId = getAuth(request).userId;

    const page = await listNearbyGroups(callerId, {
      query: query.q ?? '',
      categories: splitCategories(query.category),
      interestIds: splitInterestIds(query.interest),
      matchMyInterests: query.matched === 'true',
      visibility: query.visibility ?? null,
      limit: query.limit,
      offset: query.offset,
      radiusMeters: query.radius ?? DEFAULT_RADIUS_METERS,
    });

    response.json({ page });
  }),
);

groupsRouter.get(
  '/mine',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(membershipQuerySchema, request);

    const page = await listMyGroups(getAuth(request).userId, {
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

groupsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = parseQuery(listQuerySchema, request);
    const callerId = getAuth(request).userId;

    const page = await listGroups(callerId, {
      query: query.q ?? '',
      categories: splitCategories(query.category),
      interestIds: splitInterestIds(query.interest),
      matchMyInterests: query.matched === 'true',
      visibility: query.visibility ?? null,
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

groupsRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);

    const group = await getGroup(getAuth(request).userId, params.id);
    response.json({ group });
  }),
);

// -----------------------------------------------------------------------------
// Creation, editing and archiving
// -----------------------------------------------------------------------------

groupsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (request, response) => {
    const body = parseBody(groupDraftSchema, request);

    const group = await createGroup(getAuth(request).userId, toDraft(body));
    response.status(201).json({ group });
  }),
);

/**
 * A patch carries only what changed, so "absent" means "leave it alone" rather than
 * "clear it" - which is why each field is conditionally spread rather than passed as
 * `undefined`. `locationLabel: null` is a real instruction (clear the label) and is
 * preserved as such.
 */
groupsRouter.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);
    const body = parseBody(groupPatchSchema, request);

    const group = await updateGroup(getAuth(request).userId, params.id, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.category === undefined ? {} : { category: body.category as GroupCategoryId }),
      ...(body.interestId === undefined ? {} : { interestId: body.interestId ?? null }),
      ...(body.visibility === undefined ? {} : { visibility: body.visibility as GroupVisibility }),
      ...(body.audience === undefined ? {} : { audience: body.audience as GroupAudience }),
      ...(body.locationLabel === undefined ? {} : { locationLabel: body.locationLabel ?? null }),
      ...(body.latitude === undefined ? {} : { latitude: body.latitude ?? null }),
      ...(body.longitude === undefined ? {} : { longitude: body.longitude ?? null }),
      ...(body.removeLocation === undefined ? {} : { removeLocation: body.removeLocation }),
    });

    response.json({ group });
  }),
);

groupsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);

    await archiveGroup(getAuth(request).userId, params.id);
    response.status(204).send();
  }),
);

// -----------------------------------------------------------------------------
// Membership
// -----------------------------------------------------------------------------

groupsRouter.post(
  '/:id/join',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);

    const group = await joinGroup(getAuth(request).userId, params.id);
    response.json({ group });
  }),
);

groupsRouter.post(
  '/:id/leave',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);

    const group = await leaveGroup(getAuth(request).userId, params.id);
    response.json({ group });
  }),
);

groupsRouter.post(
  '/:id/join-request/cancel',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);

    const group = await cancelJoinRequest(getAuth(request).userId, params.id);
    response.json({ group });
  }),
);

groupsRouter.get(
  '/:id/members',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);
    const query = parseQuery(membershipQuerySchema, request);

    const page = await listMembers(getAuth(request).userId, params.id, {
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

groupsRouter.get(
  '/:id/join-requests',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);
    const query = parseQuery(membershipQuerySchema, request);

    const page = await listJoinRequests(getAuth(request).userId, params.id, {
      limit: query.limit,
      offset: query.offset,
    });

    response.json({ page });
  }),
);

groupsRouter.post(
  '/:id/join-requests/:userId/approve',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(memberParamsSchema, request);

    const decided = await approveJoinRequest(getAuth(request).userId, params.id, params.userId);
    response.json({ request: decided });
  }),
);

groupsRouter.post(
  '/:id/join-requests/:userId/reject',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(memberParamsSchema, request);

    const decided = await rejectJoinRequest(getAuth(request).userId, params.id, params.userId);
    response.json({ request: decided });
  }),
);

groupsRouter.patch(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(memberParamsSchema, request);
    const body = parseBody(memberRoleSchema, request);

    const member = await setMemberRole(
      getAuth(request).userId,
      params.id,
      params.userId,
      body.role as 'admin' | 'member',
    );

    response.json({ member });
  }),
);

groupsRouter.delete(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(memberParamsSchema, request);

    await removeMember(getAuth(request).userId, params.id, params.userId);
    response.status(204).send();
  }),
);

// -----------------------------------------------------------------------------
// Chat (Phase 7)
//
// Two endpoints, both Members-only. They exist alongside the Socket.IO transport
// rather than instead of it: history always comes over HTTP (so a page is a page
// whether or not a socket is connected), and a send works over either - the socket
// handler calls the same `sendGroupMessage`, so the two paths cannot diverge.
// -----------------------------------------------------------------------------

const messageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_MESSAGE_PAGE_SIZE).default(MESSAGE_PAGE_SIZE),
  /**
   * The immutable id of the oldest message the client already has. Not an offset:
   * messages arrive while a member scrolls, and an offset would re-serve rows.
   */
  before: z.string().uuid('That chat page is not valid.').optional(),
});

const messageDraftSchema = z.object({
  body: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  /**
   * A client-generated UUID, repeated only when the client is retrying a message it
   * is not sure landed. The unique index makes the second attempt resolve to the
   * first row, so a flaky connection cannot post the same sentence twice.
   */
  clientMessageId: z.string().uuid('That message reference is not valid.').optional(),
});

groupsRouter.get(
  '/:id/messages',
  requireAuth,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);
    const query = parseQuery(messageQuerySchema, request);

    const page = await listGroupMessages(getAuth(request).userId, params.id, {
      limit: query.limit,
      before: query.before ?? null,
    });

    response.json({ page });
  }),
);

groupsRouter.post(
  '/:id/messages',
  requireAuth,
  messageLimiter,
  asyncHandler(async (request, response) => {
    const params = parseParams(groupIdParamsSchema, request);
    const body = parseBody(messageDraftSchema, request);

    const message = await sendGroupMessage(
      getAuth(request).userId,
      params.id,
      body.body,
      body.clientMessageId ?? null,
    );

    response.status(201).json({ message });
  }),
);


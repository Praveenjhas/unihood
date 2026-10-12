/**
 * Groups data access.
 *
 * One module for every group call, exactly as `peopleRepo` is for discovery: the
 * screens work with camel-cased records, and nothing above this file knows a URL.
 *
 * Three details are worth stating because screens depend on them:
 *
 *   * `nearby` needs a fix the server already holds. When it does not, the API
 *     answers `location_required`, which callers detect with
 *     `hasApiErrorCode(caught, 'location_required')` and turn into an explanation
 *     rather than an error banner.
 *   * `audience_not_eligible` (403) is a *final* answer, not a retry: the member's
 *     own eligibility setting is the thing to change, and the UI links there.
 *   * a rejected or removed membership is also final. The server refuses those
 *     joins with `forbidden`, so no screen offers the button again.
 *
 * `distanceMeters` is server-rounded; the UI formats it with
 * `formatApproximateDistance`, which never shows an exact figure.
 */
import { DEFAULT_RADIUS_METERS, apiRequest, clampRadiusMeters, hasApiErrorCode } from '../../lib';
import {
  GROUP_CATEGORY_IDS,
  GROUP_PAGE_SIZE,
  type DecidedRequest,
  type Group,
  type GroupAudience,
  type GroupCategoryId,
  type GroupDraft,
  type GroupMember,
  type GroupMemberPage,
  type GroupPage,
  type GroupRequestPage,
  type GroupRole,
  type GroupVisibility,
  type MembershipStatus,
} from '../../types';

/** The largest page the API accepts. */
const MAX_PAGE_SIZE = 50;

/** One group as it arrives on the wire. */
interface GroupPayload {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  interestId?: string | null;
  visibility?: string;
  audience?: string;
  locationLabel?: string | null;
  hasLocation?: boolean;
  distanceMeters?: number | null;
  memberCount?: number;
  owner?: { id?: string; displayName?: string } | null;
  viewerMembership?: { role?: string; status?: string } | null;
  viewerIsOwner?: boolean;
  viewerCanManage?: boolean;
  viewerEligible?: boolean;
  pendingRequestCount?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
}

interface GroupPagePayload {
  page?: {
    groups?: GroupPayload[] | null;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  };
}

interface MemberPayload {
  userId?: string;
  displayName?: string;
  role?: string;
  joinedAt?: string | null;
}

interface MemberPagePayload {
  page?: {
    members?: MemberPayload[] | null;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  };
}

interface RequestPayload {
  userId?: string;
  displayName?: string;
  requestedAt?: string | null;
}

interface RequestPagePayload {
  page?: {
    requests?: RequestPayload[] | null;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  };
}

const CATEGORY_IDS = new Set<string>(GROUP_CATEGORY_IDS);

/** Keeps an unknown server value from reaching a component that switches on it. */
function asCategory(value: string | undefined): GroupCategoryId {
  return value !== undefined && CATEGORY_IDS.has(value) ? (value as GroupCategoryId) : 'general';
}

function asVisibility(value: string | undefined): GroupVisibility {
  return value === 'private' ? 'private' : 'public';
}

function asAudience(value: string | undefined): GroupAudience {
  return value === 'men_only' || value === 'women_only' ? value : 'everyone';
}

function asRole(value: string | undefined): GroupRole {
  return value === 'owner' || value === 'admin' ? value : 'member';
}

function mapGroup(payload: GroupPayload): Group {
  const owner = payload.owner;
  const membership = payload.viewerMembership;

  return {
    id: String(payload.id ?? ''),
    name: String(payload.name ?? 'Untitled group'),
    description: String(payload.description ?? ''),
    category: asCategory(payload.category),
    interestId: payload.interestId ?? null,
    visibility: asVisibility(payload.visibility),
    audience: asAudience(payload.audience),
    locationLabel: payload.locationLabel ?? null,
    hasLocation: payload.hasLocation === true,
    distanceMeters: typeof payload.distanceMeters === 'number' ? payload.distanceMeters : null,
    memberCount: typeof payload.memberCount === 'number' ? payload.memberCount : 0,
    owner: owner?.id ? { id: String(owner.id), displayName: String(owner.displayName ?? 'Member') } : null,
    viewerMembership: membership?.status ? { role: asRole(membership.role), status: membership.status as MembershipStatus } : null,
    viewerIsOwner: payload.viewerIsOwner === true,
    viewerCanManage: payload.viewerCanManage === true,
    viewerEligible: payload.viewerEligible !== false,
    pendingRequestCount: typeof payload.pendingRequestCount === 'number' ? payload.pendingRequestCount : null,
    createdAt: payload.createdAt ?? null,
    updatedAt: payload.updatedAt ?? null,
    archivedAt: payload.archivedAt ?? null,
  };
}

function mapMember(payload: MemberPayload): GroupMember {
  return {
    userId: String(payload.userId ?? ''),
    displayName: String(payload.displayName ?? 'Member'),
    role: asRole(payload.role),
    joinedAt: payload.joinedAt ?? null,
  };
}


/** Which listing the Groups screen is showing. */
export type GroupListMode = 'nearby' | 'all' | 'mine';

export interface GroupQueryOptions {
  mode: GroupListMode;
  /** Free text matched against the name and description. */
  query?: string;
  categories?: readonly GroupCategoryId[];
  /**
   * Interest ids the group's own primary interest must be one of. An empty list
   * means "any interest" - it is not the same as `matchMyInterests`, which asks
   * the server for the groups *the viewer* would be a match for.
   */
  interestIds?: readonly string[];
  /** Nearby/discovery only; keep only groups whose interest the viewer shares. */
  matchMyInterests?: boolean;
  /** Nearby only; clamped to the server's 1-10 km window. */
  radiusMeters?: number;
  limit?: number;
  offset?: number;
}

/** One page of groups for the current listing. */
export async function fetchGroupsPage(options: GroupQueryOptions): Promise<GroupPage> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(options.limit ?? GROUP_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const categories = options.categories && options.categories.length > 0 ? [...options.categories].join(',') : '';
  const interestIds =
    options.interestIds && options.interestIds.length > 0 ? [...options.interestIds].join(',') : '';

  const path =
    options.mode === 'nearby' ? '/api/groups/nearby' : options.mode === 'mine' ? '/api/groups/mine' : '/api/groups';

  const payload = await apiRequest<GroupPagePayload>(path, {
    query:
      options.mode === 'mine'
        ? { limit, offset }
        : {
            q: options.query?.trim() ?? '',
            category: categories,
            interest: interestIds,
            // Sent as the literal the API parses; anything else would be a 400.
            matched: options.matchMyInterests ? 'true' : 'false',
            radius:
              options.mode === 'nearby' ? clampRadiusMeters(options.radiusMeters ?? DEFAULT_RADIUS_METERS) : undefined,
            limit,
            offset,
          },
  });

  const page = payload?.page;
  const groups = (page?.groups ?? []).map(mapGroup);
  const hasMore = page?.hasMore ?? groups.length === limit;

  return {
    groups,
    offset: page?.offset ?? offset,
    hasMore,
    nextOffset: page?.nextOffset ?? (hasMore ? offset + groups.length : null),
  };
}

/**
 * Thrown by `fetchGroup` when the API has no such group.
 *
 * A distinct class so the detail screen can tell "this answer will not change"
 * (the id never existed) from "the request failed" and offer a retry only for the
 * second case.
 */
export class GroupNotAvailableError extends Error {
  constructor() {
    super('We could not find that group. It may have been removed, or the link is out of date.');
    this.name = 'GroupNotAvailableError';
  }
}

/** One group, for the detail and edit screens. */
export async function fetchGroup(groupId: string): Promise<Group> {
  try {
    return await requestGroup(`/api/groups/${groupId}`);
  } catch (caught) {
    if (hasApiErrorCode(caught, 'not_found')) throw new GroupNotAvailableError();
    throw caught;
  }
}

/** The request body shared by create and edit. */
function draftBody(draft: GroupDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    category: draft.category,
    interestId: draft.interestId,
    visibility: draft.visibility,
    audience: draft.audience,
    locationLabel: draft.locationLabel,
    latitude: draft.latitude,
    longitude: draft.longitude,
  };
}

export async function createGroup(draft: GroupDraft): Promise<Group> {
  return requestGroup('/api/groups', { method: 'POST', body: draftBody(draft) });
}

/**
 * Saves an edit.
 *
 * `removeLocation` is sent on its own when the owner cleared the anchor, so a
 * changed name never doubles as a location write.
 */
export async function updateGroup(groupId: string, draft: GroupDraft): Promise<Group> {
  const body =
    draft.removeLocation && draft.latitude === null
      ? { ...draftBody(draft), removeLocation: true }
      : draftBody(draft);
  return requestGroup(`/api/groups/${groupId}`, { method: 'PATCH', body });
}

/** Archives the group. Nothing is deleted; the API only sets `archived_at`. */
export async function archiveGroup(groupId: string): Promise<void> {
  await apiRequest(`/api/groups/${groupId}`, { method: 'DELETE' });
}

/**
 * Joins (public) or requests to join (private).
 *
 * The refreshed group comes back either way, so the caller renders whatever the
 * server now holds rather than guessing at a post-action state.
 */
export async function joinGroup(groupId: string): Promise<Group> {
  return requestGroup(`/api/groups/${groupId}/join`, { method: 'POST' });
}

export async function leaveGroup(groupId: string): Promise<Group> {
  return requestGroup(`/api/groups/${groupId}/leave`, { method: 'POST' });
}

export async function cancelJoinRequest(groupId: string): Promise<Group> {
  return requestGroup(`/api/groups/${groupId}/join-request/cancel`, { method: 'POST' });
}

/** Reads one group out of a `{ group }` response, refusing an empty payload. */
async function requestGroup(path: string, options: Parameters<typeof apiRequest>[1] = {}): Promise<Group> {
  const payload = await apiRequest<{ group?: GroupPayload }>(path, options);
  if (!payload?.group) throw new Error('That group is not available. It may have been removed.');
  return mapGroup(payload.group);
}

/** The active member list. Readable by members; never carries eligibility. */
export async function fetchGroupMembers(
  groupId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<GroupMemberPage> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(options.limit ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  const payload = await apiRequest<MemberPagePayload>(`/api/groups/${groupId}/members`, {
    query: { limit, offset },
  });

  const page = payload?.page;
  const members = (page?.members ?? []).map(mapMember);
  const hasMore = page?.hasMore ?? members.length === limit;

  return {
    members,
    offset: page?.offset ?? offset,
    hasMore,
    nextOffset: page?.nextOffset ?? (hasMore ? offset + members.length : null),
  };
}

/** The pending request queue. Owners and administrators only. */
export async function fetchJoinRequests(
  groupId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<GroupRequestPage> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(options.limit ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  const payload = await apiRequest<RequestPagePayload>(`/api/groups/${groupId}/join-requests`, {
    query: { limit, offset },
  });

  const page = payload?.page;
  const requests = (page?.requests ?? []).map((entry) => ({
    userId: String(entry.userId ?? ''),
    displayName: String(entry.displayName ?? 'Member'),
    requestedAt: entry.requestedAt ?? null,
  }));
  const hasMore = page?.hasMore ?? requests.length === limit;

  return {
    requests,
    offset: page?.offset ?? offset,
    hasMore,
    nextOffset: page?.nextOffset ?? (hasMore ? offset + requests.length : null),
  };
}

/** Approves a pending request. The decision, not the membership, is the answer. */
export async function approveJoinRequest(groupId: string, userId: string): Promise<DecidedRequest> {
  const payload = await apiRequest<{ request?: DecidedRequest }>(
    `/api/groups/${groupId}/join-requests/${userId}/approve`,
    { method: 'POST' },
  );
  if (!payload?.request) throw new Error('That request could not be approved.');
  return payload.request;
}

export async function rejectJoinRequest(groupId: string, userId: string): Promise<DecidedRequest> {
  const payload = await apiRequest<{ request?: DecidedRequest }>(
    `/api/groups/${groupId}/join-requests/${userId}/reject`,
    { method: 'POST' },
  );
  if (!payload?.request) throw new Error('That request could not be declined.');
  return payload.request;
}

/** Promotes an administrator, or returns one to a member. Owner-only, server-side. */
export async function setMemberRole(
  groupId: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<GroupMember> {
  const payload = await apiRequest<{ member?: MemberPayload }>(`/api/groups/${groupId}/members/${userId}`, {
    method: 'PATCH',
    body: { role },
  });
  if (!payload?.member) throw new Error('That role change could not be saved.');
  return mapMember(payload.member);
}

export async function removeMember(groupId: string, userId: string): Promise<void> {
  await apiRequest(`/api/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
}

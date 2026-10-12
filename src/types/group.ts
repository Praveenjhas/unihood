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

export interface GroupCategory {
  id: GroupCategoryId;
  label: string;
}

/** Public groups are discoverable and open; private groups require approval. */
export type GroupVisibility = 'public' | 'private';

/** Who a group is for. Restricted audiences check the member's own setting. */
export type GroupAudience = 'everyone' | 'men_only' | 'women_only';

export type GroupRole = 'owner' | 'admin' | 'member';

/**
 * The five membership states the API can report, mirroring
 * `group_memberships.status`:
 *
 * `pending`  - a request awaiting approval (private groups only)
 * `active`   - a member
 * `rejected` - a request that was declined; the member cannot re-ask
 * `left`     - left voluntarily, or withdrew a request; may re-ask
 * `removed`  - removed by an owner or administrator; the member cannot re-ask
 */
export type MembershipStatus = 'pending' | 'active' | 'rejected' | 'left' | 'removed';

/**
 * The optional, self-declared value that decides eligibility for men-only and
 * women-only groups. It is only ever read back on the member's own profile.
 */
export type GroupEligibilityGender = 'man' | 'woman' | 'another' | 'prefer_not_to_say';

export interface GroupMembership {
  role: GroupRole;
  status: MembershipStatus;
}

/**
 * A group as the API describes it.
 *
 * Two fields are conditional by design: `owner` is `null` unless the viewer is a
 * member or the group is public, and `pendingRequestCount` is `null` unless the
 * viewer may manage the group. `distanceMeters` is set only by a nearby search and
 * is rounded to 50 m; no endpoint ever returns a coordinate.
 */
export interface Group {
  id: string;
  name: string;
  description: string;
  category: GroupCategoryId;
  /**
   * The group's single primary interest, from the member interest catalogue, or
   * `null` when the owner picked none.
   *
   * `null` is a real answer rather than a gap: an interest is a discovery aid, so a
   * group without one is still listed everywhere - it is simply ranked after the
   * groups whose interest the viewer shares.
   */
  interestId: string | null;
  visibility: GroupVisibility;
  audience: GroupAudience;
  locationLabel: string | null;
  /** True when the group has a geographic anchor for nearby discovery. */
  hasLocation: boolean;
  distanceMeters: number | null;
  memberCount: number;
  owner: { id: string; displayName: string } | null;
  viewerMembership: GroupMembership | null;
  viewerIsOwner: boolean;
  viewerCanManage: boolean;
  /** False when the group's audience excludes the viewer. */
  viewerEligible: boolean;
  pendingRequestCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
}

export interface GroupPage {
  groups: Group[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** One active member, as the member list returns it. Never carries eligibility. */
export interface GroupMember {
  userId: string;
  displayName: string;
  role: GroupRole;
  joinedAt: string | null;
}

export interface GroupMemberPage {
  members: GroupMember[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** One pending join request, for the owner/administrator queue. */
export interface GroupRequest {
  userId: string;
  displayName: string;
  requestedAt: string | null;
}

export interface GroupRequestPage {
  requests: GroupRequest[];
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** The result of approving or rejecting a request. */
export interface DecidedRequest {
  userId: string;
  displayName: string;
  status: MembershipStatus;
}

/** The writable half of a group: exactly the body of the create/edit forms. */
export interface GroupDraft {
  name: string;
  description: string;
  category: GroupCategoryId;
  /** The primary interest, or `null` for "none". Validated by the API. */
  interestId: string | null;
  visibility: GroupVisibility;
  audience: GroupAudience;
  locationLabel: string | null;
  /** The group's own anchor. Both are `null` when the group has none. */
  latitude: number | null;
  longitude: number | null;
  /** Set by the editor to drop the anchor without touching the rest. */
  removeLocation: boolean;
}

/** Field limits enforced by the API, counted against by the form. */
export const GROUP_NAME_MIN_LENGTH = 3;
export const GROUP_NAME_MAX_LENGTH = 60;
export const GROUP_DESCRIPTION_MAX_LENGTH = 280;
export const GROUP_LOCATION_LABEL_MAX_LENGTH = 80;

/** Rows per request; matches the server's page size so a page is never truncated. */
export const GROUP_PAGE_SIZE = 20;

export function emptyGroupDraft(): GroupDraft {
  return {
    name: '',
    description: '',
    category: 'general',
    interestId: null,
    visibility: 'public',
    audience: 'everyone',
    locationLabel: null,
    latitude: null,
    longitude: null,
    removeLocation: false,
  };
}

/**
 * Seeds the editor from a stored group.
 *
 * The coordinates are deliberately *not* carried over: the API never returns them,
 * so "this group has an anchor" arrives as `hasLocation`. The editor shows that
 * state and lets the owner replace it with a fresh read of the device's position -
 * which is also why `removeLocation` starts false.
 */
export function groupDraftFrom(group: Group): GroupDraft {
  return {
    name: group.name,
    description: group.description,
    category: group.category,
    interestId: group.interestId,
    visibility: group.visibility,
    audience: group.audience,
    locationLabel: group.locationLabel,
    latitude: null,
    longitude: null,
    removeLocation: false,
  };
}

/**
 * What the join control should offer, derived from the group alone.
 *
 * `blocked` is a decision someone made about the member (a declined request or a
 * removal). The server refuses those outright, so the UI says so rather than
 * offering a button that cannot work.
 */
export type GroupMembershipState = 'none' | 'active' | 'pending' | 'blocked';

export function membershipStateOf(group: Group): GroupMembershipState {
  switch (group.viewerMembership?.status) {
    case 'active':
      return 'active';
    case 'pending':
      return 'pending';
    case 'rejected':
    case 'removed':
      return 'blocked';
    default:
      return 'none';
  }
}

/** True when the group is taken down: reads work, every action is refused. */
export function isArchived(group: Group): boolean {
  return group.archivedAt !== null;
}

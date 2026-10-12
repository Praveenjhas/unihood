/**
 * Profile data access.
 *
 * The API is the trust boundary now, so this module is thin on purpose: it calls
 * `/api/profile/me`, and the server validates every field, replaces the interest
 * set and marks the profile complete in one transaction. The onboarding form and
 * the editor therefore share exactly one write path, as they did through the
 * `save_my_profile` function before it.
 *
 * Reads are only ever the caller's own row - there is no route that returns
 * another member's private profile - so nothing here can leak one by accident.
 */
import { apiRequest, type ApiRequestOptions } from '../../lib';
import { normalizeInterestIds, type Profile, type ProfileDraft } from '../../types';
import type { GroupEligibilityGender } from '../../types/group';

/**
 * The eligibility values the server accepts. Checked here as well so an unknown
 * value from a future server never reaches a component that switches on it.
 */
const ELIGIBILITY_VALUES: readonly GroupEligibilityGender[] = ['man', 'woman', 'another', 'prefer_not_to_say'];

function asEligibility(value: string | null | undefined): GroupEligibilityGender | null {
  return value !== null && value !== undefined && (ELIGIBILITY_VALUES as readonly string[]).includes(value)
    ? (value as GroupEligibilityGender)
    : null;
}

/** What `GET`/`PUT /api/profile/me` answers with, as it arrives on the wire. */
interface ProfilePayload {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  bio: string | null;
  avatarPath: string | null;
  locationLabel: string | null;
  interestIds?: string[] | null;
  isDiscoverable: boolean;
  nearbyDiscoveryEnabled: boolean;
  groupEligibilityGender?: string | null;
  profileCompleted: boolean;
  locationUpdatedAt: string | null;
  updatedAt: string | null;
}

function mapProfile(payload: ProfilePayload): Profile {
  return {
    id: payload.id,
    email: payload.email,
    phone: payload.phone ?? null,
    displayName: payload.displayName,
    bio: payload.bio,
    avatarPath: payload.avatarPath,
    locationLabel: payload.locationLabel,
    interestIds: normalizeInterestIds(payload.interestIds ?? []),
    isDiscoverable: payload.isDiscoverable === true,
    nearbyDiscoveryEnabled: payload.nearbyDiscoveryEnabled === true,
    groupEligibilityGender: asEligibility(payload.groupEligibilityGender),
    profileCompleted: payload.profileCompleted === true,
    locationUpdatedAt: payload.locationUpdatedAt,
    updatedAt: payload.updatedAt,
  };
}

/**
 * One profile request.
 *
 * A missing `profile` key is treated as an error rather than as "this member is
 * new": registration creates the row in the same transaction as the account, so
 * an absent row means something is wrong with the account.
 */
async function requestProfile(path: string, options: ApiRequestOptions): Promise<Profile> {
  const payload = await apiRequest<{ profile?: ProfilePayload }>(path, options);
  if (!payload?.profile) throw new Error('Your profile could not be found. Sign out and in again.');
  return mapProfile(payload.profile);
}

/** The caller's profile. */
export async function fetchMyProfile(): Promise<Profile> {
  return requestProfile('/api/profile/me', {});
}

/**
 * Creates/updates the caller's profile. Marks it complete unless told not to.
 *
 * `options.complete` is what the onboarding steps use: `false` saves the work
 * without finishing the profile, so abandoning onboarding halfway keeps the name
 * and interests that were already entered and the guard brings the member back to
 * the same flow. Omitting it is the finishing write.
 */
export async function saveMyProfile(
  draft: ProfileDraft,
  options: { complete?: boolean } = {},
): Promise<Profile> {
  return requestProfile('/api/profile/me', {
    method: 'PUT',
    body: {
      displayName: draft.displayName.trim(),
      bio: draft.bio,
      avatarPath: draft.avatarPath,
      locationLabel: draft.locationLabel,
      interestIds: draft.interestIds,
      isDiscoverable: draft.isDiscoverable,
      nearbyDiscoveryEnabled: draft.nearbyDiscoveryEnabled,
      groupEligibilityGender: draft.groupEligibilityGender,
      complete: options.complete ?? true,
    },
  });
}

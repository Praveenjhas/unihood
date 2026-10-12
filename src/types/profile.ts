import type { GroupEligibilityGender } from './group';

/**
 * The signed-in member, as the API returns it from `GET /api/profile/me`.
 *
 * This is the wire shape (camel-cased) so there is exactly one mapping layer -
 * `src/features/profile/profileRepo.ts` - between the API and the UI. There are
 * deliberately no campus/program/year fields: Unihood is a location-based social
 * app, not a student directory.
 */
export interface Profile {
  /** `auth.users.id`, also `profiles.id`. */
  id: string;
  /** From the auth session only — never stored in the public schema. */
  email: string | null;
  /**
   * The E.164 number this account signs in with, returned only on the member's own
   * profile. `null` for an account created before phone sign-in existed.
   */
  phone: string | null;
  displayName: string;
  bio: string | null;
  /** Storage key of the avatar in the `avatars` bucket; `null` until uploaded. */
  avatarPath: string | null;
  /** Free-text area label the member typed (e.g. "Riverside"). Never geocoded. */
  locationLabel: string | null;
  /** Selected interest ids, sorted; the join table is the source of truth. */
  interestIds: string[];
  /** Opt-in for appearing in name search and on the public profile route. */
  isDiscoverable: boolean;
  /** Opt-in for storing a location fix and appearing in nearby discovery. */
  nearbyDiscoveryEnabled: boolean;
  /**
   * The optional, self-declared value that decides eligibility for men-only and
   * women-only groups. `null` means "not set", which is the default. It is returned
   * only on the member's own profile - never in discovery, never to a group
   * administrator - and nothing requires it.
   */
  groupEligibilityGender: GroupEligibilityGender | null;
  /** Set once onboarding has been submitted; drives the onboarding redirect. */
  profileCompleted: boolean;
  /** When the stored location fix was taken, or `null` if none is stored. */
  locationUpdatedAt: string | null;
  updatedAt: string | null;
}

/**
 * Field limits enforced by `PUT /api/profile/me`.
 *
 * They are declared beside the types rather than in each screen so the forms can
 * count characters and block an over-long value before a round-trip, while the
 * server stays the authority: if these ever drift, the API rejects the write
 * and `describeError` reports the server's own sentence.
 */
export const DISPLAY_NAME_MAX_LENGTH = 60;
export const BIO_MAX_LENGTH = 280;
export const LOCATION_LABEL_MAX_LENGTH = 80;
export const MAX_PROFILE_INTERESTS = 12;

/**
 * The writable half of a profile — exactly what the onboarding form and the
 * profile editor can change, and exactly the body of `PUT /api/profile/me`.
 */
export interface ProfileDraft {
  displayName: string;
  bio: string | null;
  avatarPath: string | null;
  locationLabel: string | null;
  interestIds: string[];
  isDiscoverable: boolean;
  nearbyDiscoveryEnabled: boolean;
  /** Optional and independent of every switch above; `null` clears it. */
  groupEligibilityGender: GroupEligibilityGender | null;
}

export function emptyProfileDraft(): ProfileDraft {
  return {
    displayName: '',
    bio: null,
    avatarPath: null,
    locationLabel: null,
    interestIds: [],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: false,
    groupEligibilityGender: null,
  };
}

/** Seeds the onboarding/editor form from an existing profile. */
export function draftFromProfile(profile: Profile | null): ProfileDraft {
  if (!profile) return emptyProfileDraft();
  return {
    displayName: profile.displayName === 'New member' ? '' : profile.displayName,
    bio: profile.bio,
    avatarPath: profile.avatarPath,
    locationLabel: profile.locationLabel,
    interestIds: [...profile.interestIds],
    isDiscoverable: profile.isDiscoverable,
    nearbyDiscoveryEnabled: profile.nearbyDiscoveryEnabled,
    groupEligibilityGender: profile.groupEligibilityGender,
  };
}

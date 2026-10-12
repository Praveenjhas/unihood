/**
 * The signed-in member's own profile.
 *
 * This is the only module that knows the database shape of `profiles` and
 * `profile_interests`; everything above it works with camel-cased records. It
 * replaces the `save_my_profile` Postgres function from the Supabase build with
 * one transaction that does the same five things:
 *
 *   1. validate every field (lengths, the display name, the interest vocabulary);
 *   2. update the profile row, always marking it complete;
 *   3. replace the interest set - replace-all, so removals work;
 *   4. **delete the stored location when nearby consent is withdrawn**, which
 *      Supabase enforced with a trigger and which must not be separable from the
 *      profile write;
 *   5. return the saved row, so the client never needs a second round trip.
 *
 * Validation lives here rather than only in the mobile form because the API is
 * the trust boundary: a hand-crafted request must hit the same rules.
 */
import type { RowDataPacket } from 'mysql2/promise';

import { pool, withTransaction } from '../db/pool';
import { GROUP_ELIGIBILITY_VALUES, type GroupEligibility } from '../domain/groups';
import { toIso } from '../lib/dates';
import { AppError, badRequest } from '../lib/errors';
import { activeInterestIds } from './interestService';

export const DISPLAY_NAME_MAX_LENGTH = 60;
export const BIO_MAX_LENGTH = 280;
export const LOCATION_LABEL_MAX_LENGTH = 80;
export const MAX_PROFILE_INTERESTS = 12;

/** The member's own row: everything the profile tab and editor render. */
export interface MemberProfile {
  id: string;
  /** From `users.email`; never published to other members. */
  email: string | null;
  /**
   * From `users.phone_e164`, already E.164, on the member's *own* row only.
   *
   * It is part of the caller's own profile because the profile screen shows which
   * number they signed in with, and it is deliberately absent from every other
   * projection: no People card, no group member list, no public profile.
   */
  phone: string | null;
  displayName: string;
  bio: string | null;
  avatarPath: string | null;
  locationLabel: string | null;
  interestIds: string[];
  isDiscoverable: boolean;
  nearbyDiscoveryEnabled: boolean;
  /**
   * The optional, self-declared eligibility used by men-only / women-only groups.
   * `null` means "never asked", which is the default for every account. The value
   * only ever leaves the API on the member's *own* profile row - it is never part
   * of a public projection and never part of a group member list.
   */
  groupEligibilityGender: GroupEligibility | null;
  profileCompleted: boolean;
  locationUpdatedAt: string | null;
  updatedAt: string | null;
}

/** The writable half - exactly what the onboarding form and editor can change. */
export interface ProfileDraft {
  displayName: string;
  bio: string | null;
  avatarPath: string | null;
  locationLabel: string | null;
  interestIds: string[];
  isDiscoverable: boolean;
  nearbyDiscoveryEnabled: boolean;
  /** Optional and independent of every switch above; `null` clears it. */
  groupEligibilityGender: GroupEligibility | null;
}

interface ProfileRow extends RowDataPacket {
  user_id: string;
  email: string | null;
  phone_e164: string | null;
  display_name: string;
  bio: string | null;
  avatar_path: string | null;
  location_label: string | null;
  is_discoverable: number;
  nearby_discovery_enabled: number;
  group_eligibility_gender: GroupEligibility | null;
  profile_completed: number;
  location_updated_at: Date | null;
  updated_at: Date | null;
  interest_ids_csv: string | null;
}

const PROFILE_SELECT = `
  SELECT p.user_id,
         u.email,
         u.phone_e164,
         p.display_name,
         p.bio,
         p.avatar_path,
         p.location_label,
         p.is_discoverable,
         p.nearby_discovery_enabled,
         p.group_eligibility_gender,
         p.profile_completed,
         (SELECT ul.location_updated_at FROM user_locations ul WHERE ul.user_id = p.user_id) AS location_updated_at,
         p.updated_at,
         (SELECT GROUP_CONCAT(pi.interest_id ORDER BY pi.interest_id SEPARATOR ',')
            FROM profile_interests pi WHERE pi.user_id = p.user_id) AS interest_ids_csv
    FROM profiles p
    JOIN users u ON u.id = p.user_id
   WHERE p.user_id = ?`;

function splitInterestIds(csv: string | null): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function mapProfile(row: ProfileRow): MemberProfile {
  return {
    id: row.user_id,
    email: row.email,
    phone: row.phone_e164,
    displayName: row.display_name,
    bio: row.bio,
    avatarPath: row.avatar_path,
    locationLabel: row.location_label,
    interestIds: splitInterestIds(row.interest_ids_csv),
    isDiscoverable: row.is_discoverable === 1,
    nearbyDiscoveryEnabled: row.nearby_discovery_enabled === 1,
    groupEligibilityGender: row.group_eligibility_gender ?? null,
    profileCompleted: row.profile_completed === 1,
    locationUpdatedAt: toIso(row.location_updated_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * The caller's profile.
 *
 * A missing row is an error rather than an empty profile: the row is created in
 * the same transaction as the account (see `authService.register`), so its
 * absence means the account is damaged, not that the member is new.
 */
export async function getMyProfile(userId: string): Promise<MemberProfile> {
  const [rows] = await pool.query<ProfileRow[]>(PROFILE_SELECT, [userId]);

  const row = rows[0];
  if (!row) {
    throw new AppError('profile_not_found', 404, 'Your profile could not be found. Sign out and in again.');
  }

  return mapProfile(row);
}

// -----------------------------------------------------------------------------
// Validation and the single write path
// -----------------------------------------------------------------------------

const trimmedOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Checks and normalises a draft.
 *
 * Rejecting rather than trimming away a problem is deliberate: a member who
 * typed a 300-character bio should be told it is too long, not have it silently
 * cut in half.
 */
function normalizeDraft(draft: ProfileDraft): ProfileDraft {
  const displayName = draft.displayName.trim();
  if (displayName.length < 1) {
    throw badRequest('A display name is required.', { field: 'displayName' });
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw badRequest(`Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`, { field: 'displayName' });
  }

  const bio = trimmedOrNull(draft.bio);
  if (bio !== null && bio.length > BIO_MAX_LENGTH) {
    throw badRequest(`Bio must be ${BIO_MAX_LENGTH} characters or fewer.`, { field: 'bio' });
  }

  const avatarPath = trimmedOrNull(draft.avatarPath);
  if (avatarPath !== null) {
    if (avatarPath.length > 512) {
      throw badRequest('Avatar path must be 512 characters or fewer.', { field: 'avatarPath' });
    }
    // A storage *path*, never a URL - the same rule as the column's CHECK.
    if (avatarPath.includes('://')) {
      throw badRequest('The avatar must be a storage path, not a web address.', { field: 'avatarPath' });
    }
  }

  const locationLabel = trimmedOrNull(draft.locationLabel);
  if (locationLabel !== null && locationLabel.length > LOCATION_LABEL_MAX_LENGTH) {
    throw badRequest(`The area label must be ${LOCATION_LABEL_MAX_LENGTH} characters or fewer.`, {
      field: 'locationLabel',
    });
  }

  const isDiscoverable = draft.isDiscoverable !== false;
  const nearbyDiscoveryEnabled = draft.nearbyDiscoveryEnabled === true;

  // Mirrors profiles_nearby_requires_discoverable_chk; catching it here gives the
  // client an actionable sentence instead of a constraint name.
  if (nearbyDiscoveryEnabled && !isDiscoverable) {
    throw badRequest('Nearby discovery needs a discoverable profile. Turn "Show me in People" back on first.', {
      field: 'nearbyDiscoveryEnabled',
    });
  }

  const unique = new Set<string>();
  for (const candidate of draft.interestIds ?? []) {
    if (typeof candidate !== 'string') continue;
    const id = candidate.trim();
    if (id.length > 0) unique.add(id);
  }

  if (unique.size > MAX_PROFILE_INTERESTS) {
    throw badRequest(`Choose at most ${MAX_PROFILE_INTERESTS} interests.`, { field: 'interestIds' });
  }

  // Optional and never inferred: absent or null clears it, an unknown string is
  // refused rather than coerced. The column's CHECK is the second line of defence.
  const groupEligibilityGender = draft.groupEligibilityGender ?? null;
  if (
    groupEligibilityGender !== null &&
    !(GROUP_ELIGIBILITY_VALUES as readonly string[]).includes(groupEligibilityGender)
  ) {
    throw badRequest('Choose one of the listed eligibility options, or leave it unset.', {
      field: 'groupEligibilityGender',
    });
  }

  return {
    displayName,
    bio,
    avatarPath,
    locationLabel,
    interestIds: [...unique].sort(),
    isDiscoverable,
    nearbyDiscoveryEnabled,
    groupEligibilityGender,
  };
}

/**
 * Creates/updates the caller's profile and returns the saved row.
 *
 * One transaction covers the profile row, the interest set and the consent-driven
 * location deletion, so a dropped connection can never leave a member with
 * interests deleted but not re-inserted - the failure mode the Supabase build
 * avoided with a single PL/pgSQL function.
 *
 * `complete` exists for onboarding (Phase 5). Onboarding saves each step, because
 * losing a finished list of interests to a killed app is exactly the kind of
 * thing that makes people abandon a sign-up - so the first steps write the row
 * with `complete: false`, and the last step flips it. A finished profile is
 * still the default, so every other caller is unaffected, and the flag is only
 * ever set by this function: `profile_completed` cannot be turned back off by a
 * member editing their profile.
 */
export async function saveMyProfile(
  userId: string,
  draft: ProfileDraft,
  options: { complete?: boolean } = {},
): Promise<MemberProfile> {
  const complete = options.complete ?? true;
  const next = normalizeDraft(draft);

  const known = await activeInterestIds(next.interestIds);
  const unknown = next.interestIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw badRequest('One or more selected interests are unknown or inactive.', {
      field: 'interestIds',
      unknown,
    });
  }

  await withTransaction(async (connection) => {
    const [existing] = await connection.query<RowDataPacket[]>(
      'SELECT user_id FROM profiles WHERE user_id = ? FOR UPDATE',
      [userId],
    );

    if (existing.length === 0) {
      throw new AppError('profile_not_found', 404, 'Your profile could not be found. Sign out and in again.');
    }

    await connection.query(
      `UPDATE profiles
          SET display_name = ?,
              bio = ?,
              avatar_path = ?,
              location_label = ?,
              is_discoverable = ?,
              nearby_discovery_enabled = ?,
              group_eligibility_gender = ?,
              profile_completed = GREATEST(profile_completed, ?)
        WHERE user_id = ?`,
      [
        next.displayName,
        next.bio,
        next.avatarPath,
        next.locationLabel,
        next.isDiscoverable ? 1 : 0,
        next.nearbyDiscoveryEnabled ? 1 : 0,
        next.groupEligibilityGender,
        // Onboarding's intermediate steps pass 0; the final step passes 1. An
        // already-complete profile therefore stays complete whatever a later
        // partial save says, and a member can never be pushed back into
        // onboarding by editing their profile.
        complete ? 1 : 0,
        userId,
      ],
    );

    // `users.display_name` is kept in step with the profile it names. The two
    // start identical (`authService.register` copies the name into both, and a
    // phone-created account uses the same placeholder in each), and the
    // account-level copy is what the emailed "thanks, <name>" and the session
    // user read - so letting it go stale here would mean a member's own name
    // disagreed with itself in two places.
    await connection.query('UPDATE users SET display_name = ? WHERE id = ?', [next.displayName, userId]);

    // Replace-all: a removal is only possible if the previous set is cleared
    // first, and the transaction makes the gap invisible.
    await connection.query('DELETE FROM profile_interests WHERE user_id = ?', [userId]);

    if (next.interestIds.length > 0) {
      const placeholders = next.interestIds.map(() => '(?, ?)').join(', ');
      const values = next.interestIds.flatMap((interestId) => [userId, interestId]);
      await connection.query(
        `INSERT INTO profile_interests (user_id, interest_id) VALUES ${placeholders}`,
        values,
      );
    }

    // Consent withdrawn: the stored fix must not survive the write. This replaces
    // Supabase's `clear_location_without_consent` trigger, and living inside the
    // same transaction is what stops the profile and the location from disagreeing.
    if (!next.nearbyDiscoveryEnabled) {
      await connection.query('DELETE FROM user_locations WHERE user_id = ?', [userId]);
    }
  });

  return getMyProfile(userId);
}

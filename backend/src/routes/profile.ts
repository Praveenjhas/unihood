/**
 * The signed-in member's own profile.
 *
 *   GET /api/profile/me  -> { profile }
 *   PUT /api/profile/me  -> { profile }   (creates/updates; marks complete)
 *
 * `profile.phone` is the caller's own E.164 number, present only here - no other
 * projection returns it.
 *
 * `complete` is what onboarding's intermediate steps set to `false`, so a member
 * who abandons step two of three finds their name and interests still saved and
 * is sent back into onboarding by the same guard that sent them there the first
 * time. It defaults to `true`, so every other caller keeps the original promise
 * that a write through this route finishes the profile.
 *
 * The zod schema here checks *types and shapes* only. Field lengths, the interest
 * vocabulary and the consent rule are enforced in `profileService`, next to the
 * SQL, so the API and the database can never disagree about what is allowed.
 */
import { Router } from 'express';
import { z } from 'zod';

import { GROUP_ELIGIBILITY_VALUES } from '../domain/groups';
import { parseBody } from '../http/validate';
import { asyncHandler } from '../lib/asyncHandler';
import { getAuth, requireAuth } from '../middleware/requireAuth';
import { getMyProfile, saveMyProfile } from '../services/profileService';

export const profileRouter = Router();

/**
 * Generous upper bounds - the real limits are smaller and are reported with
 * member-facing wording by the service. These exist so an oversized payload
 * cannot reach the service at all.
 */
const profileDraftSchema = z.object({
  displayName: z.string().max(400),
  bio: z.string().max(2000).nullish(),
  avatarPath: z.string().max(2000).nullish(),
  locationLabel: z.string().max(400).nullish(),
  interestIds: z.array(z.string().max(64)).max(64).default([]),
  isDiscoverable: z.boolean().default(true),
  nearbyDiscoveryEnabled: z.boolean().default(false),
  /**
   * Optional and self-declared. Only men-only / women-only groups read it, and the
   * enum is built from the domain list so a client cannot widen the set.
   */
  groupEligibilityGender: z.enum(GROUP_ELIGIBILITY_VALUES).nullish(),
  /** `false` while onboarding is still in progress. Absent means "finished". */
  complete: z.boolean().default(true),
});

profileRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    const profile = await getMyProfile(getAuth(request).userId);
    response.json({ profile });
  }),
);

profileRouter.put(
  '/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    const body = parseBody(profileDraftSchema, request);

    const profile = await saveMyProfile(
      getAuth(request).userId,
      {
        displayName: body.displayName,
        bio: body.bio ?? null,
        avatarPath: body.avatarPath ?? null,
        locationLabel: body.locationLabel ?? null,
        interestIds: body.interestIds,
        isDiscoverable: body.isDiscoverable,
        nearbyDiscoveryEnabled: body.nearbyDiscoveryEnabled,
        groupEligibilityGender: body.groupEligibilityGender ?? null,
      },
      { complete: body.complete },
    );

    response.json({ profile });
  }),
);

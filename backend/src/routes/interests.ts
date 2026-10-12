/**
 * The interest vocabulary.
 *
 *   GET /api/interests -> { interests: [{ id, label }] }
 *
 * Read-only, and authenticated: the catalog is what a signed-in member picks
 * from, so there is no reason to answer anonymous callers. The response shape is
 * the same `{ id, label }` pair the mobile chips already render, which is why
 * `interestsRepo.ts` needed no reshaping when Supabase was removed.
 */
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { listActiveInterests } from '../services/interestService';

export const interestsRouter = Router();

interestsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_request, response) => {
    response.json({ interests: await listActiveInterests() });
  }),
);

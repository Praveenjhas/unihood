/**
 * The account itself.
 *
 * One endpoint: `DELETE /api/account`, which closes the caller's account.
 *
 * `DELETE` rather than a verb-shaped POST because the row and everything hanging off
 * it really does go. It is mounted behind the same `authLimiter` as `/login`,
 * because it re-verifies a password and is therefore the same guessing target. The
 * password travels in the body - it is a credential, not part of a URL - and
 * `confirm` must carry the word `DELETE` that the member typed, so neither an
 * accidental request nor a stale client can close an account on its own.
 *
 * The response reports what was removed (`archivedGroups`, `cancelledEvents`,
 * `removedMessages`): a destructive operation should be able to say what it did.
 * Every session on the account goes with the row, including the one that asked, so
 * the client answers by clearing its stored session and returning to the welcome
 * screen.
 */
import { Router } from 'express';
import { z } from 'zod';

import { parseBody } from '../http/validate';
import { asyncHandler } from '../lib/asyncHandler';
import { getAuth, requireAuth } from '../middleware/requireAuth';
import { authLimiter } from '../middleware/rateLimit';
import { deleteMyAccount } from '../services/accountService';

export const accountRouter = Router();

/** The password the caller types on the deletion screen. Empty is a validation error. */
const passwordField = z
  .string()
  .min(1, 'Enter your password.')
  .max(200, 'Passwords must be 200 characters or fewer.');

/**
 * The word the app makes the member type.
 *
 * Checked here as well as in the form, because the form is a convenience and this is
 * the rule: the API refuses a deletion that nobody spelled out.
 */
const confirmField = z
  .string()
  .trim()
  .refine((value) => value === 'DELETE', 'Type DELETE to confirm.');

accountRouter.delete(
  '/',
  authLimiter,
  requireAuth,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object({ password: passwordField, confirm: confirmField }).strict(), request);

    const summary = await deleteMyAccount(getAuth(request).userId, body.password);

    response.json({ deleted: true, ...summary });
  }),
);

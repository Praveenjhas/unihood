/**
 * Rate limiting.
 *
 * Two buckets, because "use the app" and "guess a password" are not the same
 * request:
 *
 *   * `apiLimiter`   - every request, a generous ceiling that stops a runaway
 *                      client without getting in a real member's way.
 *   * `authLimiter`  - registration, sign-in, refresh and both password-recovery
 *                      endpoints, where the cost of a wrong answer is a
 *                      credential-stuffing attempt.
 *
 * Limits are per client IP and in-process. That is the right shape for a single
 * Node process; behind more than one instance the counters would need a shared
 * store, which is called out in the README rather than quietly assumed.
 *
 * The one bucket that is deliberately *not* here is the group-chat write: an
 * address is the wrong key for it (two transports would need two counters, and a
 * client could spend one and then the other), so it is counted per member in
 * `messageLimit.ts`, where the HTTP route and the socket handler both spend it.
 */
import rateLimit from 'express-rate-limit';

import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { sendError } from '../http/respond';

const tooManyRequests = new AppError(
  'rate_limited',
  429,
  'Too many attempts just now. Wait a minute and try again.',
);

const shared = {
  windowMs: env.rateLimit.windowMs,
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  // The default handler returns plain text; every other response on this API is
  // the JSON error envelope, so it is replaced.
  handler: (_request: unknown, response: Parameters<typeof sendError>[0]) => {
    sendError(response, tooManyRequests);
  },
};

export const apiLimiter = rateLimit({ ...shared, limit: env.rateLimit.max });
export const authLimiter = rateLimit({ ...shared, limit: env.rateLimit.authMax });

/**
 * The SMS path gets its own bucket.
 *
 * Two reasons it is not folded into `authLimiter`: a one-time code costs real
 * money to send, and the interesting attack against it is *per number* rather
 * than per address. `otpService` owns the per-number limits (cooldown and hourly
 * ceiling); this is the per-IP half of the same defence, so one caller cannot
 * walk through a list of numbers.
 */
export const otpLimiter = rateLimit({ ...shared, limit: env.rateLimit.otpMax });

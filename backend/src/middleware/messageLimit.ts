/**
 * The per-member message budget.
 *
 * Phase 7 gave the chat two ways in - `POST /api/groups/:id/messages` and the
 * socket's `message:send` - which means a ceiling that watched only one of them was
 * a ceiling a client could step around by switching transport. This module is the
 * single allowance both paths spend from, keyed by the *authenticated member*
 * rather than by an address or a socket, so two devices, two transports and any
 * number of parallel requests all draw on the same number.
 *
 * Four properties are deliberate:
 *
 *   1. **It is spent before anything else happens.** Both callers spend *after*
 *      identity is established (the session check on the socket, `requireAuth` over
 *      HTTP) and *before* validation, membership and the insert - so a flood of
 *      malformed or unauthorized attempts is bounded by the same counter as a flood
 *      of valid ones, and no write can be reached without paying for it.
 *   2. **Spending is synchronous, so it is atomic.** `spendMessageBudget` reads and
 *      writes the counter with no `await` anywhere inside it, so a burst of parallel
 *      submissions cannot all observe the same "one left": Node's event loop runs
 *      each call to completion, and there is no read-modify-write gap to lose a
 *      write in.
 *   3. **One refusal, two shapes.** `messageBudgetError` is the only place the
 *      sentence and the `retryAfterSeconds` are written. It is what the HTTP
 *      middleware returns as a 429 and what the socket answers its acknowledgement
 *      with, so a client cannot tell the two transports apart by their error - which
 *      is the point.
 *   4. **It is per process, and the README says so.** The counters live in this
 *      module's memory: one Node process enforces one budget, a restart forgets
 *      every window, and two instances behind a load balancer would each enforce
 *      their own. Distributed enforcement needs a shared store and is not claimed
 *      here.
 *
 * A fixed window - rather than a sliding one or a bucket of tokens - is the right
 * shape for this: cheap, obvious to reason about, and generous. The default is 300
 * writes per 15 minutes per member, which is far past anyone typing, and it reaches
 * zero only for a client in a loop.
 */
import type { RequestHandler } from 'express';

import { env } from '../config/env';
import { sendError } from '../http/respond';
import { AppError } from '../lib/errors';
import { getAuth } from './requireAuth';

/** The ceiling and the window, read once at startup from `config/env.ts`. */
const LIMIT = env.rateLimit.messageMax;
const WINDOW_MS = env.rateLimit.messageWindowMs;
/** Whole seconds, for the headers - the same number a client counts down with. */
const WINDOW_SECONDS = Math.round(WINDOW_MS / 1000);

interface Window {
  /** When this member's current window opened, on the server's own clock. */
  startedAt: number;
  /** Submissions counted in it, refusals included. */
  spent: number;
}

const windows = new Map<string, Window>();

/**
 * How many live windows are tolerated before the map is swept.
 *
 * The map is bounded by "members who sent a message in the last window" rather than
 * by "every id ever seen", and it is swept inline - no timer, so importing this
 * module never keeps a process alive.
 */
const SWEEP_ABOVE = 512;

export interface MessageBudgetDecision {
  allowed: boolean;
  /** Submissions left in the member's current window; never reported below zero. */
  remaining: number;
  /** Whole seconds until the window resets and the allowance is whole again. */
  retryAfterSeconds: number;
}

function windowFor(userId: string, now: number): Window {
  const current = windows.get(userId);
  if (current !== undefined && now - current.startedAt < WINDOW_MS) return current;

  const opened: Window = { startedAt: now, spent: 0 };
  windows.set(userId, opened);
  return opened;
}

/**
 * Counts one submission against a member's window and says whether it may proceed.
 *
 * Every submission is counted, including one that is about to be refused: a refusal
 * that cost nothing would let a loop retry at full speed. `remaining` therefore
 * reaches zero and stays there for the rest of the window - the allowance refills
 * when the window rolls over, not per attempt.
 */
export function spendMessageBudget(userId: string): MessageBudgetDecision {
  const now = Date.now();

  if (windows.size >= SWEEP_ABOVE) {
    for (const [id, open] of windows) {
      if (now - open.startedAt >= WINDOW_MS) windows.delete(id);
    }
  }

  const window = windowFor(userId, now);
  const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000));

  window.spent += 1;

  return {
    allowed: window.spent <= LIMIT,
    remaining: Math.max(0, LIMIT - window.spent),
    retryAfterSeconds,
  };
}

/**
 * The one refusal, in the API's own error vocabulary.
 *
 * `retryAfterSeconds` travels in `details` exactly as `otp_throttled` carries it,
 * so a screen can count down instead of guessing; the same sentence and the same
 * detail go to a socket client, which is why they are written here rather than
 * inside either transport. `limit` and `windowSeconds` are reported too, so a
 * client - or a support conversation - can see what the budget actually was.
 */
export function messageBudgetError(retryAfterSeconds: number): AppError {
  const seconds = `${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}`;

  return new AppError(
    'rate_limited',
    429,
    `You are sending messages faster than the chat allows. Try again in ${seconds}.`,
    { retryAfterSeconds, limit: LIMIT, windowSeconds: WINDOW_SECONDS },
  );
}

/**
 * The HTTP half.
 *
 * Mounted *after* `requireAuth` and before the route handler: the member is known
 * and the write has not happened yet. The two `RateLimit` headers are the ones
 * express-rate-limit writes for the per-IP buckets (`standardHeaders: 'draft-7'`),
 * so a client reads its message budget with the code it already uses for the
 * others; `Retry-After` is added on the refusal, which is what an HTTP client is
 * entitled to expect. Mounted without `requireAuth`, `getAuth` throws and Express
 * answers 401 - it fails closed rather than counting anonymously.
 */
export const messageLimiter: RequestHandler = (request, response, next) => {
  const decision = spendMessageBudget(getAuth(request).userId);

  response.setHeader('RateLimit-Policy', `${LIMIT};w=${WINDOW_SECONDS}`);
  response.setHeader(
    'RateLimit',
    `limit=${LIMIT}, remaining=${decision.remaining}, reset=${decision.retryAfterSeconds}`,
  );

  if (!decision.allowed) {
    response.setHeader('Retry-After', String(decision.retryAfterSeconds));
    sendError(response, messageBudgetError(decision.retryAfterSeconds));
    return;
  }

  next();
};

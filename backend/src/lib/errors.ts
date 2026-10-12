/**
 * The API's error model.
 *
 * Every failure that a caller is allowed to see is an `AppError` carrying three
 * things the mobile client needs: a stable machine `code` (so the app can say
 * "confirm your email" without matching on prose), an HTTP `status`, and a
 * sentence written for a member rather than for a developer.
 *
 * Anything that is *not* an `AppError` is a bug or an infrastructure failure and
 * is reported as a generic 500 - the stack trace stays in the server log. That
 * split is what keeps SQL text, column names and connection details out of
 * responses (the previous Supabase build leaked PostgREST wording here).
 */

export const ERROR_CODES = [
  /** Request body / query failed validation. */
  'validation_error',
  /**
   * The credential does not match an account: a phone number and password on
   * `/api/auth/login`, an email and password on the legacy email endpoints.
   */
  'invalid_credentials',
  /** Correct credentials, but the address has not been confirmed. */
  'email_not_verified',
  /** An account already uses that address. */
  'email_taken',
  /** A verification / reset / refresh token is unknown, expired or already used. */
  'invalid_token',
  'token_expired',
  /** The access token is missing, malformed, expired or revoked. */
  'unauthorized',
  'session_expired',
  /** Authenticated, but not allowed to do this. */
  'forbidden',
  /** Nearby discovery is switched off for the account. */
  'nearby_disabled',
  /** The caller has no location fix young enough to search from. */
  'location_required',
  /**
   * The caller's self-declared eligibility does not match the group's audience
   * (`men_only` / `women_only`), or they have not set one at all.
   */
  'audience_not_eligible',
  /** The group has been archived: it cannot be joined, edited or managed. */
  'group_archived',
  /**
   * The account being deleted owns a group that still has other active members.
   * A group cannot be left ownerless, so ownership has to move (or the members be
   * removed) before the account can go.
   */
  'ownership_transfer_required',
  /** Every place at an event with a participant limit is taken. */
  'event_full',
  /** The event has already finished, so no new RSVP can be recorded. */
  'event_ended',
  /** The event was cancelled by its creator or a group administrator. */
  'event_cancelled',
  'not_found',
  'profile_not_found',
  /** Too many requests from this address. */
  'rate_limited',
  /** The account has been disabled by an administrator. */
  'account_disabled',
  /** A phone number could not be read as a valid international number. */
  'phone_invalid',
  /** The number is already verified on another account. */
  'phone_taken',
  /**
   * The number belongs to an account that has never had a password - a phone-only
   * account, whose `password_hash` is NULL because migration 0008 made the column
   * nullable and no password was ever invented for it. A one-time code is the way
   * in, and the refusal says so rather than pretending the password was wrong.
   */
  'password_not_set',
  /**
   * A code was asked for again too soon, or too often in the last hour. `details`
   * carries `retryAfterSeconds` so the screen can count down instead of guessing.
   */
  'otp_throttled',
  /** The code is wrong, was already used, or was replaced by a newer one. */
  'otp_invalid',
  /** The code was right once, but its five minutes are over. */
  'otp_expired',
  /** Too many wrong codes for this challenge; a new code must be requested. */
  'otp_attempts_exceeded',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Extra machine-readable detail (e.g. the failing field names). */
  readonly details: unknown;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isAppError(caught: unknown): caught is AppError {
  return caught instanceof AppError;
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('validation_error', 400, message, details);

export const unauthorized = (message = 'Sign in to continue.'): AppError =>
  new AppError('unauthorized', 401, message);

export const sessionExpired = (message = 'Your session has expired. Sign in again to continue.'): AppError =>
  new AppError('session_expired', 401, message);

export const forbidden = (message = 'This account is not allowed to do that.'): AppError =>
  new AppError('forbidden', 403, message);

export const notFound = (message = 'That was not found.'): AppError =>
  new AppError('not_found', 404, message);

export const conflict = (code: ErrorCode, message: string): AppError => new AppError(code, 409, message);

/**
 * MySQL error numbers that map onto member-facing outcomes.
 *
 * `ER_DUP_ENTRY` is the one that matters in practice: two concurrent registrations
 * for the same address race past the application-level SELECT, and the unique key
 * on `users.email` is what actually decides. Translating it here means the loser
 * of that race gets "an account already uses that email" instead of a 500.
 *
 * Since Phase 5 there are two unique keys an insert can trip (`users.email` and
 * `users.phone_e164`), so the error's own text decides which sentence is honest -
 * MySQL names the index in `Duplicate entry ... for key 'users_phone_e164_key'`.
 */
export function translateDatabaseError(caught: unknown): AppError | null {
  const errno = (caught as { errno?: unknown }).errno;

  switch (errno) {
    case 1062: // ER_DUP_ENTRY
      return /phone_e164/i.test(String((caught as { message?: unknown }).message ?? ''))
        ? conflict('phone_taken', 'That phone number is already used by another account.')
        : conflict('email_taken', 'An account already uses that email. Sign in instead.');
    case 1264: // ER_WARN_DATA_OUT_OF_RANGE
    case 1265: // WARN_DATA_TRUNCATED (strict mode: the CHECK failed)
    case 3819: // ER_CHECK_CONSTRAINT_VIOLATED
      return badRequest('That request was not valid. Check the values and try again.');
    case 1452: // ER_NO_REFERENCED_ROW_2
    case 1451: // ER_ROW_IS_REFERENCED_2
      return badRequest('That change refers to something that no longer exists.');
    default:
      return null;
  }
}

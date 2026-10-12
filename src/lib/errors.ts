/**
 * Error presentation.
 *
 * Every failure in the data layer arrives as one of three shapes:
 *
 *   * `BackendNotConfiguredError` — no API URL is set, so nothing can work and
 *     the member should be sent to the configuration screen;
 *   * `ApiError` — the API answered with its error envelope
 *     (`{ error: { code, message, details } }`). The server writes `message` for
 *     a *member*, not for a developer, and `code` is a stable machine value the
 *     app switches on (see `backend/src/lib/errors.ts` for the full list);
 *   * `NetworkError` — the request never reached the API at all.
 *
 * This module is the single place that turns any of them into one sentence, so
 * no screen has to invent copy or match on prose.
 *
 * `describeError` never throws and always returns a string.
 */
import { missingBackendMessage } from './env';

/**
 * Thrown when no API URL is configured. It is a distinct class so screens can
 * tell "the backend is not set up" (a configuration problem the member fixes
 * once) from "this request failed" (a retryable error).
 */
export class BackendNotConfiguredError extends Error {
  constructor() {
    super(missingBackendMessage);
    this.name = 'BackendNotConfiguredError';
  }
}

export function isBackendNotConfigured(caught: unknown): caught is BackendNotConfiguredError {
  return caught instanceof BackendNotConfiguredError;
}

/** The API's error envelope, as thrown. */
export class ApiError extends Error {
  /** Stable machine code, e.g. `invalid_credentials` or `nearby_disabled`. */
  readonly code: string;
  /** HTTP status, for callers that branch on the class of failure. */
  readonly status: number;
  /** Whatever the server attached (usually the failing field names). */
  readonly details: unknown;

  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(caught: unknown): caught is ApiError {
  return caught instanceof ApiError;
}

/** True when the failure carries one of the given codes. */
export function hasApiErrorCode(caught: unknown, ...codes: readonly string[]): boolean {
  return isApiError(caught) && codes.includes(caught.code);
}

/**
 * The request never reached the API: no connection, DNS failure, timeout.
 *
 * A class rather than a string match on the platform's wording, which differs
 * between iOS, Android and web.
 */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('We could not reach Unihood. Check your connection and try again.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export function isNetworkError(caught: unknown): caught is NetworkError {
  return caught instanceof NetworkError;
}

export function toError(caught: unknown): Error {
  if (caught instanceof Error) return caught;
  if (typeof caught === 'string' && caught.trim()) return new Error(caught);
  return new Error('Something went wrong. Please try again.');
}

/**
 * Sentences for the API's error codes.
 *
 * A *fallback*: the server already sends member-facing wording for every code,
 * and that is what is shown. The map covers the case the server cannot - a proxy
 * or a future endpoint answering with a status but no envelope.
 */
const CODE_MESSAGES: Record<string, string> = {
  validation_error: 'Check the highlighted details and try again.',
  invalid_credentials: 'That phone number and password do not match an account.',
  password_not_set:
    'That account has no password on it yet. Ask whoever runs Unihood to set one, then sign in with it.',
  phone_taken: 'That number already has an account. Sign in instead, or use a different number.',
  phone_invalid: 'That phone number does not look right.',
  email_not_verified: 'Confirm your email address first - the link we sent is still waiting.',
  email_taken: 'An account already uses that email. Sign in instead.',
  invalid_token: 'That link is not valid. Ask for a new one.',
  token_expired: 'That link has expired. Ask for a new one.',
  unauthorized: 'Sign in to continue.',
  session_expired: 'Your session has expired. Sign in again to continue.',
  forbidden: 'This account is not allowed to do that.',
  nearby_disabled: 'Turn nearby discovery on in your profile before sharing a location.',
  location_required: 'Share your location before searching nearby people.',
  audience_not_eligible:
    'Your gender setting does not match this group or event. You can change it in your profile.',
  group_archived: 'That group has been archived, so it cannot be joined or used.',
  ownership_transfer_required:
    'You still own a group with other members. Hand it on, or remove its members, before closing your account.',
  event_full: 'This event is full, so no more places are available.',
  event_ended: 'This event has already finished.',
  event_cancelled: 'This event was cancelled.',
  not_found: 'That was not found.',
  profile_not_found: 'Your profile could not be found. Sign out and in again.',
  rate_limited: 'Too many attempts just now. Wait a minute and try again.',
  account_disabled: 'This account has been switched off. Contact whoever runs Unihood.',
  internal_error: 'Something went wrong on our side. Please try again.',
};

/** Platform wordings for a request that never left the device. */
const NETWORK_PATTERNS = [
  'Failed to fetch',
  'Network request failed',
  'NetworkError',
  'network error',
  'Load failed',
  'fetch failed',
  'timed out',
  'timeout',
  'The Internet connection appears to be offline',
];

/**
 * One human sentence for anything thrown in the data layer.
 *
 * Order matters: a configuration problem and a network failure are recognisable
 * by type before any message is inspected.
 */
export function describeError(caught: unknown): string {
  if (isBackendNotConfigured(caught)) return missingBackendMessage;
  if (isNetworkError(caught)) return caught.message;

  if (isApiError(caught)) {
    // The server's sentence is written for a member and is more specific than
    // anything this module could invent; the map only fills the gaps.
    const message = caught.message.trim();
    if (message.length > 0) return message;
    return CODE_MESSAGES[caught.code] ?? 'Something went wrong. Please try again.';
  }

  const error = toError(caught);
  const message = error.message.trim();

  if (NETWORK_PATTERNS.some((pattern) => message.toLowerCase().includes(pattern.toLowerCase()))) {
    return new NetworkError().message;
  }

  return message || 'Something went wrong. Please try again.';
}

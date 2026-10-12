/**
 * Deep-link target validation.
 *
 * The confirmation and reset emails contain a link back to *this API*, which
 * then bounces the reader into the app at the address they supplied when they
 * signed up (`unihood://auth/callback`, or the `exp://` form under Expo Go).
 *
 * That redirect target is attacker-influenced by definition - it is a request
 * body field - so it is checked against an allowlist of schemes before it is
 * ever stored. Without this, the API would be an open redirect reachable through
 * a legitimate-looking email link.
 */
import { env } from '../config/env';
import { badRequest } from './errors';

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;

/** True when `value` is a URL whose scheme is on the configured allowlist. */
export function isAllowedRedirect(value: string): boolean {
  const match = SCHEME_PATTERN.exec(value.trim());
  if (!match?.[1]) return false;
  return env.http.allowedRedirectSchemes.includes(match[1].toLowerCase());
}

/**
 * Validates a client-supplied redirect target.
 *
 * Returns `null` for "none given", which is a legitimate state: a member who
 * asks for a reset from a client that has no deep-link support still gets a
 * working link, they just finish on the API's own confirmation page.
 */
export function normalizeRedirectTarget(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.length > 255) {
    throw badRequest('That redirect address is too long.', { field: 'redirectTo' });
  }

  if (!isAllowedRedirect(trimmed)) {
    throw badRequest(
      `Redirect addresses must start with one of: ${env.http.allowedRedirectSchemes.join(', ')}.`,
      { field: 'redirectTo' },
    );
  }

  return trimmed;
}

/** Appends query parameters to a deep link, respecting an existing `?`. */
export function appendQueryParams(base: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString();
  if (search.length === 0) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${search}`;
}

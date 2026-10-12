import type { AccessTokenClaims } from '../lib/accessToken';

/**
 * Adds the authenticated caller to Express's request type.
 *
 * `requireAuth` is the only writer. Handlers read it through `getAuth(request)`
 * rather than touching `request.auth` directly, so the "route was mounted
 * without the guard" case is a single throw instead of a scattered non-null
 * assertion.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`; absent on public routes. */
      auth?: AccessTokenClaims;
    }
  }
}

export {};

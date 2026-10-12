/**
 * The authorization gate.
 *
 * Two checks, both required:
 *
 *   1. **The token is genuine.** Signature, algorithm, expiry and shape are
 *      verified by `verifyAccessToken`, which never trusts the payload before
 *      that.
 *   2. **The session is still alive.** The token's `sid` is looked up in
 *      `refresh_sessions`. Without this the token would stay usable for its whole
 *      lifetime after a sign-out, a password reset or an account disable - the
 *      exact window an attacker wants. The lookup is one indexed primary-key
 *      hit, so it is cheap enough to do on every request.
 *
 * Identity is *always* taken from here and never from a request body, a query
 * parameter or a path segment. That single rule is what makes "a user cannot
 * read another user's private coordinates or move their location" a property of
 * the code shape rather than of remembering to check.
 */
import type { NextFunction, Request, RequestHandler } from 'express';
import type { RowDataPacket } from 'mysql2/promise';

import { pool } from '../db/pool';
import { verifyAccessToken, type AccessTokenClaims } from '../lib/accessToken';
import { sessionExpired, unauthorized } from '../lib/errors';

const BEARER_PREFIX = 'Bearer ';

/**
 * Confirms an access token's refresh session is still alive.
 *
 * Split out of `resolveCaller` because the real-time layer needs exactly this
 * check and nothing else - a socket has no `Request` to read a header from. The
 * same query, in the same order, so an HTTP request and a WebSocket frame cannot
 * disagree about whether a session is still valid.
 */
export async function sessionIsAlive(sessionId: string, userId: string): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT rs.id
       FROM refresh_sessions rs
       JOIN users u ON u.id = rs.user_id
      WHERE rs.id = ?
        AND rs.user_id = ?
        AND rs.revoked_at IS NULL
        AND rs.expires_at > NOW(3)
        AND u.disabled_at IS NULL`,
    [sessionId, userId],
  );

  return rows.length > 0;
}

/**
 * Verifies a raw token and confirms its session has not been revoked.
 *
 * Used by HTTP (`resolveCaller`) and by the Socket.IO handshake, so both
 * transports accept exactly the same credentials and reject the same ones.
 */
export async function resolveTokenCaller(token: string): Promise<AccessTokenClaims> {
  if (token.length === 0) throw unauthorized('Sign in to continue.');

  const claims = verifyAccessToken(token);

  // A valid token whose session is gone means "signed out elsewhere", which the
  // client answers by clearing its stored session rather than retrying.
  if (!(await sessionIsAlive(claims.sessionId, claims.userId))) throw sessionExpired();

  return claims;
}

/** Verifies the token and confirms its session has not been revoked. */
export async function resolveCaller(request: Request): Promise<AccessTokenClaims> {
  const header = request.header('authorization');
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw unauthorized('Sign in to continue.');
  }

  return resolveTokenCaller(header.slice(BEARER_PREFIX.length).trim());
}

/** Express middleware form of `resolveCaller`. */
export const requireAuth: RequestHandler = (request: Request, _response, next: NextFunction) => {
  void resolveCaller(request)
    .then((claims) => {
      request.auth = claims;
      next();
    })
    .catch(next);
};

/**
 * The caller, for a handler that was mounted behind `requireAuth`.
 *
 * Throws rather than returning `undefined` so a mis-mounted route fails closed
 * on the first request instead of silently operating without an identity.
 */
export function getAuth(request: Request): AccessTokenClaims {
  if (!request.auth) throw unauthorized('Sign in to continue.');
  return request.auth;
}

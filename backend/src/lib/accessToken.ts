/**
 * Access tokens.
 *
 * A short-lived HS256 JWT carrying the two things every authenticated request
 * needs: who is calling (`sub`) and which refresh session they came from
 * (`sid`). Nothing else is embedded - a JWT is signed, not encrypted, so a
 * profile field placed here would be readable by anyone holding the token.
 *
 * The `sid` claim is what makes "sign out everywhere" and "this device only"
 * possible: the API can check the session row is still unrevoked on every
 * request, at the cost of one indexed lookup (see `middleware/requireAuth.ts`).
 * The alternative - trusting the token until it expires - would leave a stolen
 * access token usable for its whole lifetime.
 */
import jwt from 'jsonwebtoken';

import { env } from '../config/env';
import { sessionExpired, unauthorized } from './errors';

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

interface AccessTokenPayload extends jwt.JwtPayload {
  sid?: unknown;
  typ?: unknown;
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

export function signAccessToken(claims: AccessTokenClaims): SignedAccessToken {
  const expiresAt = new Date(Date.now() + env.tokens.accessTtlSeconds * 1000);

  const token = jwt.sign({ sid: claims.sessionId, typ: 'access' }, env.tokens.accessSecret, {
    subject: claims.userId,
    algorithm: 'HS256',
    expiresIn: env.tokens.accessTtlSeconds,
  });

  return { token, expiresAt };
}

/**
 * Verifies an access token.
 *
 * Every failure is a distinct, member-readable error: an expired token is not
 * the same problem as a forged one, and the mobile client treats them
 * differently (refresh vs sign out).
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  let payload: AccessTokenPayload;

  try {
    // `algorithms` is pinned: without it a token signed with `alg: none`, or one
    // forged with the public half of an asymmetric key, would be accepted.
    payload = jwt.verify(token, env.tokens.accessSecret, { algorithms: ['HS256'] }) as AccessTokenPayload;
  } catch (caught) {
    if (caught instanceof jwt.TokenExpiredError) {
      throw sessionExpired();
    }
    throw unauthorized('Your sign-in could not be verified. Sign in again to continue.');
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  const sessionId = typeof payload.sid === 'string' ? payload.sid : null;

  if (!userId || !sessionId || payload.typ !== 'access') {
    throw unauthorized('Your sign-in could not be verified. Sign in again to continue.');
  }

  return { userId, sessionId };
}

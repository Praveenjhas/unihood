/**
 * Per-request session metadata.
 *
 * Only two facts are recorded about where a sign-in came from, both truncated to
 * what the columns allow. There is no geolocation, no device fingerprint and no
 * tracking beyond "which device list entry is this" - which is all a member needs
 * to recognise and revoke their own sessions.
 */
import type { Request } from 'express';

import type { SessionContext } from '../services/authService';

const MAX_USER_AGENT = 255;
const MAX_IP = 45; // longest textual IPv6 form

export function requestContext(request: Request): SessionContext {
  // `trust proxy` is off by default, so `request.ip` is the socket address unless
  // a deployment deliberately enables it. Reading the header anyway means a
  // reverse-proxied deployment records something useful rather than the proxy's
  // own address; it is never used for an authorization decision.
  const forwarded = request.header('x-forwarded-for');
  const ipAddress = (forwarded ? forwarded.split(',')[0] : request.ip) ?? null;

  return {
    userAgent: request.header('user-agent')?.slice(0, MAX_USER_AGENT) ?? null,
    ipAddress: ipAddress ? ipAddress.trim().slice(0, MAX_IP) : null,
  };
}

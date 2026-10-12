/**
 * Health and connectivity.
 *
 * Two endpoints with different jobs:
 *
 *   * `GET /health`    - liveness. Answers as long as the process can serve, and
 *                        is what the mobile client pings to tell "the API base
 *                        URL is wrong" from "the request failed".
 *   * `GET /health/db` - connectivity. Runs one real query and reports the server
 *                        version, the schema name, the session time zone and a
 *                        round-trip time.
 *
 * Neither response contains a host, a user name, a password or a connection
 * string - only facts a caller could not use to reach the database themselves.
 */
import { Router } from 'express';

import { probeDatabase } from '../db/pool';
import { env } from '../config/env';
import { asyncHandler } from '../lib/asyncHandler';
import { isRealtimeAttached } from '../realtime/hub';

/** Kept in step with `backend/package.json` by hand; nothing depends on it. */
const API_VERSION = '1.0.0';

export const healthRouter = Router();

healthRouter.get('/', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'unihood-api',
    version: API_VERSION,
    environment: env.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
    /**
     * Whether this process is also carrying the Socket.IO endpoint (Phase 7).
     * `false` means chat history and sending still work over HTTP - the real-time
     * channel is an optimisation, never a requirement.
     */
    realtime: isRealtimeAttached(),
  });
});

healthRouter.get(
  '/db',
  asyncHandler(async (_request, response) => {
    const probe = await probeDatabase();

    response.json({
      connected: probe.connected,
      serverVersion: probe.serverVersion,
      schema: probe.database,
      /** Must be `+00:00`; a different value means timestamps are inconsistent. */
      sessionTimeZone: probe.sessionTimeZone,
      latencyMs: probe.latencyMs,
    });
  }),
);

/**
 * The Express application.
 *
 * Kept separate from `server.ts` so the app can be built without binding a port
 * (which is what a test harness or a serverless adapter would want).
 *
 * Order matters and is: CORS, body parsing, the un-throttled health and email
 * routes, the throttled `/api` router, then the two terminal handlers. The error
 * handler is last because Express only treats a middleware as an error handler
 * when it is registered after everything that can fail.
 */
import cors from 'cors';
import express, { type Express } from 'express';

import { env } from './config/env';
import { errorHandler, notFoundHandler } from './http/errorHandler';
import { apiLimiter } from './middleware/rateLimit';
import { apiRouter, healthRouter, linksRouter } from './routes';

function corsOptions(): cors.CorsOptions {
  const allowed = env.http.corsAllowedOrigins;

  // `*` means "any origin" during local development. A real list is passed
  // through as-is. Credentials are never enabled: the app authenticates with a
  // bearer token, not a cookie, so there is no ambient authority to protect.
  if (allowed.length === 0 || allowed.includes('*')) {
    return { origin: true, credentials: false };
  }

  return { origin: allowed, credentials: false };
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(cors(corsOptions()));
  app.use(express.json({ limit: '64kb' }));

  app.use('/health', healthRouter);
  app.use('/auth', linksRouter);

  app.use('/api', apiLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

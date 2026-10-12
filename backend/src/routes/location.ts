/**
 * Location updates.
 *
 *   PUT    /api/location/me -> { locationUpdatedAt }
 *   DELETE /api/location/me -> 204
 *
 * There is no read endpoint, on purpose - the app never needs a coordinate back,
 * and not fetching one is the strongest privacy guarantee available. Both routes
 * bind the write to the caller from the access token; no user id is accepted, so
 * one member cannot move another's location.
 */
import { Router } from 'express';
import { z } from 'zod';

import { parseBody } from '../http/validate';
import { asyncHandler } from '../lib/asyncHandler';
import { getAuth, requireAuth } from '../middleware/requireAuth';
import { clearMyLocation, setMyLocation } from '../services/locationService';

export const locationRouter = Router();

const coordinateSchema = z.object({
  // `finite` rejects NaN and Infinity, which `JSON.parse` cannot produce but a
  // hand-written request can (as `1e999`).
  latitude: z.number().finite('Latitude must be a number.'),
  longitude: z.number().finite('Longitude must be a number.'),
});

locationRouter.put(
  '/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    const body = parseBody(coordinateSchema, request);

    const stored = await setMyLocation(getAuth(request).userId, body.latitude, body.longitude);
    response.json(stored);
  }),
);

locationRouter.delete(
  '/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    await clearMyLocation(getAuth(request).userId);
    response.status(204).send();
  }),
);

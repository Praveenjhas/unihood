/**
 * Route mounting.
 *
 * Two families are deliberately separated:
 *
 *   * `/api/*`   - JSON, consumed by the mobile app. Mounted behind the general
 *                  rate limiter.
 *   * `/health`  - liveness, no auth, no limiter (a monitor must never be
 *                  throttled into a false alarm).
 *   * `/auth/*`  - the two **browser** landing pages an email links to. They are
 *                  not JSON and are not part of the app's API surface.
 */
import { Router } from 'express';

import { accountRouter } from './account';
import { authRouter } from './auth';
import { eventsRouter } from './events';
import { groupsRouter } from './groups';
import { interestsRouter } from './interests';
import { locationRouter } from './location';
import { peopleRouter } from './people';
import { profileRouter } from './profile';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/account', accountRouter);
apiRouter.use('/profile', profileRouter);
apiRouter.use('/interests', interestsRouter);
apiRouter.use('/people', peopleRouter);
apiRouter.use('/location', locationRouter);
apiRouter.use('/groups', groupsRouter);
apiRouter.use('/events', eventsRouter);

export { healthRouter } from './health';
export { linksRouter } from './links';

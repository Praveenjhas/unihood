import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * middleware.
 *
 * Express 4 does not await handlers: an `async` function that throws ends up as
 * an unhandled rejection and the request hangs until it times out. Every
 * database-touching route in this API is async, so every one of them is wrapped.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

/**
 * Terminal middleware: the 404 and the error handler.
 *
 * The error handler is deliberately the only place that decides what a caller
 * learns about a failure:
 *
 *   * an `AppError` (ours) keeps its code, status and message;
 *   * a MySQL error the app can interpret is translated by
 *     `translateDatabaseError` - a duplicate key becomes "an account already uses
 *     that email" instead of `ER_DUP_ENTRY`;
 *   * **everything else becomes a bare 500.** SQL text, table and column names,
 *     file paths and stack traces go to the server log and never to the client.
 *     That is the difference between "a bug report" and "a map of the schema".
 */
import type { NextFunction, Request, Response } from 'express';

import { sendError } from '../http/respond';
import { AppError, badRequest, isAppError, notFound, translateDatabaseError } from '../lib/errors';

export function notFoundHandler(request: Request, response: Response): void {
  sendError(response, notFound(`No endpoint matches ${request.method} ${request.path}.`));
}

export function errorHandler(caught: unknown, request: Request, response: Response, _next: NextFunction): void {
  // `express.json()` rejects a malformed or oversized body by passing an error
  // with a `type`; both are client mistakes and are reported as such rather than
  // through the generic 500 below.
  const parserType = (caught as { type?: unknown }).type;

  if (parserType === 'entity.parse.failed') {
    sendError(response, badRequest('That request body was not valid JSON.'));
    return;
  }

  if (parserType === 'entity.too.large') {
    sendError(response, new AppError('validation_error', 413, 'That request was too large.'));
    return;
  }

  const known = isAppError(caught) ? caught : translateDatabaseError(caught);

  if (known) {
    // Client-side mistakes are not server incidents; only log the surprising ones.
    if (known.status >= 500) {
      console.error(`[error] ${request.method} ${request.path} -> ${known.code}`, caught);
    }
    sendError(response, known);
    return;
  }

  console.error(`[error] unhandled failure in ${request.method} ${request.path}`, caught);
  sendError(response, new AppError('internal_error', 500, 'Something went wrong on our side. Please try again.'));
}

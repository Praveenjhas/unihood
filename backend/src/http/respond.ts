/**
 * The JSON error envelope, in one place.
 *
 * Every failure leaves the API in exactly one shape:
 *
 *   { "error": { "code": "email_not_verified", "message": "...", "details": ... } }
 *
 * A stable `code` is what the mobile client switches on; `message` is only ever
 * a fallback. Keeping the envelope in one function is why no route can
 * accidentally return `{ message }` in one place and `{ error }` in another -
 * which is the usual way a client ends up with two error paths.
 */
import type { Response } from 'express';

import { AppError } from '../lib/errors';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function errorBody(error: AppError): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function sendError(response: Response, error: AppError): void {
  response.status(error.status).json(errorBody(error));
}

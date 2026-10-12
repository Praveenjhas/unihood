/**
 * Request validation helpers.
 *
 * Bodies and query strings are parsed against a zod schema **at the top of a
 * handler** rather than in middleware. The reason is `request.query`: Express
 * makes it a getter on newer versions, so replacing it from a middleware is
 * either impossible or a surprise. Parsing where it is used keeps the flow
 * obvious and gives each handler a typed value with no assertions.
 *
 * A failure is always the same thing - a 400 `validation_error` listing the
 * offending fields, which is what the mobile forms bind their inline messages
 * to. zod's own message text is used, because it is already written for a person
 * ("String must contain at least 8 character(s)").
 */
import type { Request } from 'express';
import { z, type ZodTypeAny } from 'zod';

import { badRequest } from '../lib/errors';

export interface ValidationIssue {
  path: string;
  message: string;
}

function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** Parses a JSON body. Throws `validation_error` when it does not fit. */
export function parseBody<T extends ZodTypeAny>(schema: T, request: Request): z.infer<T> {
  const result = schema.safeParse(request.body ?? {});
  if (!result.success) {
    throw badRequest('That request was not valid. Check the values and try again.', issuesOf(result.error));
  }
  return result.data;
}

/**
 * Parses the query string.
 *
 * Values arrive as strings, so every numeric or boolean field in a query schema
 * is declared with `z.coerce.*` - coercion is explicit at the schema, never
 * implicit in the handler.
 */
export function parseQuery<T extends ZodTypeAny>(schema: T, request: Request): z.infer<T> {
  const result = schema.safeParse(request.query ?? {});
  if (!result.success) {
    throw badRequest('That request was not valid. Check the values and try again.', issuesOf(result.error));
  }
  return result.data;
}

/** Parses path parameters (the `:id` segments). */
export function parseParams<T extends ZodTypeAny>(schema: T, request: Request): z.infer<T> {
  const result = schema.safeParse(request.params ?? {});
  if (!result.success) {
    throw badRequest('That link is not valid.', issuesOf(result.error));
  }
  return result.data;
}

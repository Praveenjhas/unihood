/**
 * The browser-facing side of the email links.
 *
 * A confirmation or reset link in an email points at **this API**, not directly
 * at the app, for one reason: the API has to act on the token before the app can
 * be involved. `GET /auth/verify-email` confirms the address and then hands the
 * browser to the deep link recorded when the link was requested; the reset route
 * simply forwards the token, because only the app can ask for the new password.
 *
 * Two consequences worth stating:
 *
 *   * the browser never talks to MySQL, and never sees a member's data;
 *   * the redirect target is read from the database, so a link cannot be edited
 *     into pointing somewhere else.
 *
 * When there is no `redirectTo` (a client that never supplied one) or the app
 * cannot be reached, a plain page explains what happened. The page deliberately
 * uses the same Campus Editorial palette as the app - a member who lands here
 * should not think they have left the product.
 */
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler';
import { AppError } from '../lib/errors';
import { appendQueryParams } from '../lib/redirects';
import { findPasswordResetRedirect, verifyEmail } from '../services/authService';

export const linksRouter = Router();

/** Palette mirrors `src/theme/colors.ts` (Campus Editorial). */
const PALETTE = {
  paper: '#F7F6F2',
  ink: '#252A36',
  olive: '#555C4D',
  border: '#E5E3DD',
  surface: '#FFFFFF',
  textSecondary: '#706F68',
  danger: '#8E4A3C',
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlPage(title: string, message: string, tone: 'plain' | 'danger' = 'plain'): string {
  const accent = tone === 'danger' ? PALETTE.danger : PALETTE.olive;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)} - Unihood</title>
    <style>
      html { color-scheme: light; }
      body {
        margin: 0; padding: 40px 20px; background: ${PALETTE.paper}; color: ${PALETTE.ink};
        font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      main {
        max-width: 34rem; margin: 0 auto; background: ${PALETTE.surface};
        border: 1px solid ${PALETTE.border}; border-radius: 18px; padding: 32px;
      }
      p.eyebrow {
        margin: 0 0 10px; font-size: 0.75rem; letter-spacing: 0.14em;
        text-transform: uppercase; color: ${accent};
      }
      h1 { margin: 0 0 12px; font-size: 1.5rem; line-height: 1.25; }
      p.body { margin: 0; color: ${PALETTE.textSecondary}; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Unihood</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="body">${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function readToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

linksRouter.get(
  '/verify-email',
  asyncHandler(async (request, response) => {
    const token = readToken(request.query.token);

    try {
      const outcome = await verifyEmail(token);

      if (outcome.redirectTo) {
        response.redirect(302, appendQueryParams(outcome.redirectTo, { verified: '1' }));
        return;
      }

      response
        .type('html')
        .send(htmlPage('Email confirmed', `Thanks, ${outcome.displayName}. Open Unihood and sign in.`));
    } catch (caught) {
      const message =
        caught instanceof AppError
          ? caught.message
          : 'Something went wrong confirming that link. Open Unihood and ask for a new one.';

      response.status(caught instanceof AppError ? 400 : 500).type('html').send(
        htmlPage('That link did not work', message, 'danger'),
      );
    }
  }),
);

linksRouter.get(
  '/reset-password',
  asyncHandler(async (request, response) => {
    const token = readToken(request.query.token);
    const redirectTo = token.length > 0 ? await findPasswordResetRedirect(token) : null;

    if (token.length > 0 && redirectTo) {
      // The token travels in the query string so the app can post it back. It is
      // single-use, short-lived and worth nothing without the app.
      response.redirect(302, appendQueryParams(redirectTo, { mode: 'recovery', token }));
      return;
    }

    response.status(400).type('html').send(
      htmlPage(
        'That link did not work',
        'Reset links work once and expire quickly. Open Unihood and ask for a new one.',
        'danger',
      ),
    );
  }),
);

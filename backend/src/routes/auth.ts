/**
 * Authentication endpoints.
 *
 * **A phone number and a password is the credential the app asks for**:
 *
 *   register -> 201 { user, accessToken, accessTokenExpiresAt, refreshToken,
 *                        refreshTokenExpiresAt, expiresInSeconds,
 *                        onboardingRequired }
 *   login    -> 200 { user, accessToken, ..., expiresInSeconds }
 *   change-password -> 200 { changed: true }   (Bearer; current + new password)
 *
 * `/register` and `/login` are the same two routes the email flow used, and they
 * still accept the email shape: a request carries either `phone` (the app) or
 * `email` (the accounts created before this change), and the union is what makes
 * "neither" a validation error rather than a silently ignored field.
 *
 * Kept, unchanged in shape, for the accounts an earlier version created:
 *
 *   otp/request -> 202 { sent, phone (masked), transport, delivered, failed,
 *                        expiresInSeconds, resendAfterSeconds }
 *   otp/verify  -> 200 { user, accessToken, ..., isNewAccount, onboardingRequired }
 *   /verify-email, /resend-verification, /forgot-password, /reset-password
 *
 * Nothing in the app points at the code or email paths any more. The code path
 * stays for a phone-only account - one created by a code, whose `password_hash` is
 * NULL - because that account has no password to sign in with, and `/login`
 * answers `password_not_set` to say so. `npm run phone:link` remains the
 * documented way to attach a number to a legacy email account.
 *
 *   /refresh, /logout, /change-password and /me are shared by all of them.
 *
 * `/change-password` is the only self-service way a password is ever replaced: it
 * needs the current password, and it revokes the account's other sessions while
 * leaving the caller's own alone.
 *
 * The response shapes are stable on purpose - a code, never prose, is what the
 * mobile client switches on.
 */
import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/asyncHandler';
import { MIN_PASSWORD_LENGTH } from '../lib/password';
import { normalizeRedirectTarget } from '../lib/redirects';
import { requestContext } from '../http/requestContext';
import { parseBody } from '../http/validate';
import { getAuth, requireAuth } from '../middleware/requireAuth';
import { authLimiter, otpLimiter } from '../middleware/rateLimit';
import {
  changePassword,
  getAuthenticatedUser,
  login,
  loginWithPhone,
  logout,
  refreshSession,
  register,
  registerWithPhone,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  verifyEmail,
  type AuthSession,
  type EmailDispatch,
} from '../services/authService';
import { readPhone, requestOtp, verifyOtp, type OtpRequestOutcome } from '../services/otpService';

export const authRouter = Router();

// -----------------------------------------------------------------------------
// Field schemas
// -----------------------------------------------------------------------------

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'Email addresses are 254 characters or fewer.')
  .email('That email address does not look right.');

/** Same minimum as the client form, so the two can never disagree. */
const newPasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(200, 'Passwords must be 200 characters or fewer.');

/**
 * Sign-in accepts any non-empty password: an account created before the current
 * minimum was raised must still be able to sign in and be upgraded.
 */
const existingPasswordField = z.string().min(1, 'Enter your password.').max(200, 'Passwords must be 200 characters or fewer.');

const redirectField = z.string().max(255).nullish();
const tokenField = z.string().trim().min(10, 'That link is not valid.').max(200, 'That link is not valid.');

/**
 * What the client is told about an email.
 *
 * `delivered` is false whenever no provider accepted the message - including the
 * `log` transport - and `failed` distinguishes "no provider is configured" from
 * "a provider rejected it", so the app can be honest either way instead of
 * showing "check your inbox" over a message that never left.
 */
function emailPayload(dispatch: EmailDispatch | null): {
  transport: 'smtp' | 'log';
  delivered: boolean;
  failed: boolean;
  devLink: string | null;
} | null {
  if (!dispatch) return null;

  return {
    transport: dispatch.transport,
    delivered: dispatch.delivered,
    failed: dispatch.transport === 'smtp' && !dispatch.delivered,
    devLink: dispatch.devLink,
  };
}

function sessionPayload(session: AuthSession): AuthSession {
  return session;
}

// -----------------------------------------------------------------------------
// Phone sign-in
// -----------------------------------------------------------------------------

/**
 * The two fields the phone form sends.
 *
 * Shape only - the dialling code is 1-3 digits and the subscriber part is up to
 * 15, but whether the *combination* is a real number is decided in
 * `domain/phone.ts`, which is also what the mobile form mirrors. Keeping the
 * loose bound here means a member who pastes "+91 98765 43210" into one box is
 * told what is wrong with the number, not that the request was malformed.
 */
const phoneFields = {
  countryCode: z.string().trim().min(1, 'Choose a country code.').max(8, 'That country code is not valid.'),
  nationalNumber: z.string().trim().min(4, 'Enter your phone number.').max(20, 'That phone number looks too long.'),
};

/** The code field. Digits only: nothing else can have been sent. */
const otpCodeField = z
  .string()
  .trim()
  .regex(/^[0-9]{4,10}$/, 'Enter the code from the message.');

/**
 * What the client is told about a message that may or may not have gone out.
 *
 * `delivered` is false for the `log` transport, and `failed` distinguishes "no
 * provider is configured" from "the provider rejected it" - the same honesty rule
 * the email responses follow. The code itself is never part of this payload: the
 * `log` transport writes it to `backend/.otp-outbox/` instead.
 */
function otpPayload(outcome: OtpRequestOutcome): {
  sent: true;
  phone: string;
  transport: 'log' | 'sms';
  delivered: boolean;
  failed: boolean;
  expiresInSeconds: number;
  resendAfterSeconds: number;
} {
  return {
    sent: true,
    phone: outcome.phone,
    transport: outcome.transport,
    delivered: outcome.delivered,
    failed: outcome.failed,
    expiresInSeconds: outcome.expiresInSeconds,
    resendAfterSeconds: outcome.resendAfterSeconds,
  };
}

authRouter.post(
  '/otp/request',
  otpLimiter,
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object(phoneFields), request);

    const outcome = await requestOtp(
      { countryCode: body.countryCode, nationalNumber: body.nationalNumber },
      requestContext(request).ipAddress,
    );

    // 202 whether or not the number has an account: this endpoint must not be
    // usable to find out who is registered.
    response.status(202).json(otpPayload(outcome));
  }),
);

authRouter.post(
  '/otp/verify',
  otpLimiter,
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object({ ...phoneFields, code: otpCodeField }), request);

    const outcome = await verifyOtp(
      { countryCode: body.countryCode, nationalNumber: body.nationalNumber, code: body.code },
      requestContext(request),
    );

    // `isNewAccount` is what sends the app into onboarding; `onboardingRequired`
    // is the same decision read from `profiles.profile_completed`, so a returning
    // member whose profile is somehow unfinished is still steered through it.
    response.json({
      ...sessionPayload(outcome.session),
      isNewAccount: outcome.isNewAccount,
      onboardingRequired: outcome.onboardingRequired,
    });
  }),
);

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

const displayNameField = z
  .string()
  .trim()
  .min(1, 'A display name is required.')
  .max(60, 'Display names are 60 characters or fewer.');

/**
 * Creates an account and, for a phone number, signs the member straight in.
 *
 * Two credentials, one route. The union is deliberate rather than a body with two
 * optional fields: it makes "neither" fail as a `validation_error` instead of
 * being read as an empty credential, and `.strict()` on both members means a
 * client that sends *both* is told so rather than having one silently ignored.
 *
 * The phone branch returns a session because the password has just been checked;
 * the email branch returns no session because the address has not been confirmed
 * yet, which is the behaviour it always had.
 */
authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.union([
        z
          .object({
            phone: z.object(phoneFields),
            password: newPasswordField,
            displayName: displayNameField,
          })
          .strict(),
        z
          .object({
            email: emailField,
            password: newPasswordField,
            displayName: displayNameField,
            redirectTo: redirectField,
          })
          .strict(),
      ]),
      request,
    );

    if ('phone' in body) {
      const result = await registerWithPhone(
        {
          // Normalised here, once, so everything downstream sees one shape and the
          // member's own wording ("too short", "leave out the leading 0") is what
          // they are told.
          phoneE164: readPhone(body.phone).e164,
          password: body.password,
          displayName: body.displayName,
        },
        requestContext(request),
      );

      response.status(201).json({
        ...sessionPayload(result.session),
        onboardingRequired: result.onboardingRequired,
      });
      return;
    }

    const result = await register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      redirectTo: normalizeRedirectTarget(body.redirectTo),
    });

    response.status(201).json({
      user: result.user,
      emailVerificationRequired: result.emailVerificationRequired,
      email: emailPayload(result.email),
    });
  }),
);

authRouter.post(
  '/verify-email',
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object({ token: tokenField }), request);
    const outcome = await verifyEmail(body.token);

    response.json({ verified: true, email: outcome.email, displayName: outcome.displayName });
  }),
);

authRouter.post(
  '/resend-verification',
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object({ email: emailField, redirectTo: redirectField }), request);

    const dispatch = await resendVerification(body.email, normalizeRedirectTarget(body.redirectTo));

    // 202 whether or not the address exists: this endpoint must not be usable to
    // find out which addresses have accounts.
    response.status(202).json({ sent: true, email: emailPayload(dispatch) });
  }),
);

// -----------------------------------------------------------------------------
// Sign-in, refresh, sign-out
// -----------------------------------------------------------------------------

/**
 * Signs a member in - by phone number (the app) or by email (a legacy account).
 *
 * Both branches end in the same place: `requestContext` records the device, and
 * the payload is the session payload a verified code produces, down to the
 * per-account session cap and the rotating refresh token.
 */
authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.union([
        z.object({ phone: z.object(phoneFields), password: existingPasswordField }).strict(),
        z.object({ email: emailField, password: existingPasswordField }).strict(),
      ]),
      request,
    );

    if ('phone' in body) {
      const session = await loginWithPhone(
        { phoneE164: readPhone(body.phone).e164, password: body.password },
        requestContext(request),
      );

      response.json(sessionPayload(session));
      return;
    }

    const session = await login(body.email, body.password, requestContext(request));
    response.json(sessionPayload(session));
  }),
);

authRouter.post(
  '/refresh',
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object({ refreshToken: tokenField }), request);

    const session = await refreshSession(body.refreshToken, requestContext(request));
    response.json(sessionPayload(session));
  }),
);

authRouter.post(
  '/logout',
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object({ refreshToken: tokenField }), request);

    await logout(body.refreshToken);
    // 204 and idempotent: a client that retries a sign-out must not see an error.
    response.status(204).send();
  }),
);

// -----------------------------------------------------------------------------
// Changing your own password
// -----------------------------------------------------------------------------

/**
 * Replaces the password of the account behind the access token.
 *
 * The identity is never taken from the body - `requireAuth` resolves it from the
 * token and its live session - and the current password is checked in the service,
 * so a borrowed session is not enough to change anything. `authLimiter` is on
 * because this is a password check, i.e. the same guessing target as `/login`.
 */
authRouter.post(
  '/change-password',
  authLimiter,
  requireAuth,
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.object({ currentPassword: existingPasswordField, newPassword: newPasswordField }).strict(),
      request,
    );

    const auth = getAuth(request);
    await changePassword(auth.userId, auth.sessionId, body);

    response.json({ changed: true });
  }),
);

// -----------------------------------------------------------------------------
// Password recovery
// -----------------------------------------------------------------------------

authRouter.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object({ email: emailField, redirectTo: redirectField }), request);

    const dispatch = await requestPasswordReset(body.email, normalizeRedirectTarget(body.redirectTo));

    response.status(202).json({ sent: true, email: emailPayload(dispatch) });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (request, response) => {
    const body = parseBody(z.object({ token: tokenField, password: newPasswordField }), request);

    await resetPassword(body.token, body.password);

    // No session is returned: the reset revoked every existing one, so the member
    // signs in again with the password they just chose. That is the behaviour the
    // mobile copy already promises ("setting a password here does not sign you
    // out anywhere else" refers to the *other* devices, all of which now are).
    response.json({ reset: true });
  }),
);

// -----------------------------------------------------------------------------
// The caller
// -----------------------------------------------------------------------------

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    const user = await getAuthenticatedUser(getAuth(request).userId);
    response.json({ user });
  }),
);

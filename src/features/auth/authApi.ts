/**
 * Auth transport.
 *
 * Every call the app makes against `/api/auth/*` lives here, so screens never
 * touch the HTTP client directly and every failure arrives as something
 * `describeError` can turn into one sentence.
 *
 * **A phone number and a password is the whole user-facing flow**:
 *
 *   * `registerWithPassword` creates the account - a name, a number and a
 *     password - and stores the session the API returns with it. The number
 *     belongs to that account from then on, so a second attempt at it is refused
 *     with `phone_taken`.
 *   * `signInWithPassword` exchanges the number and the password for a session.
 *     An unknown number and a wrong password fail identically
 *     (`invalid_credentials`), so the screen must not read anything into it.
 *
 * `requestPhoneOtp` / `verifyPhoneOtp` stay because `POST /api/auth/otp/*` still
 * exists, and there is exactly one account shape they serve: one created by a code
 * in an earlier version has no password, and `POST /api/auth/login` answers
 * `password_not_set` for it. Nothing in the app reaches for them any more - every
 * account the app creates has a password, and the phone number is only the name it
 * signs in with - so they are here to be called deliberately, not by a screen.
 *
 * These functions *store* the session rather than handing it back to the screen:
 * `subscribeToSession` inside `AuthProvider` is what turns the stored session into
 * UI state, and the root guard is what swaps the auth stack for onboarding or the
 * app.
 */
import { apiRequest, clearSession, readSession, saveSession, type AuthSession } from '../../lib';

/**
 * The backend's minimum, mirrored so the form can say it before a request is made.
 * `backend/src/lib/password.ts` is the authority; this is a courtesy, not a rule.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** The two fields every phone call sends. */
export interface PhoneInput {
  /** Dialling code including `+`, e.g. `+91`. */
  countryCode: string;
  /** Subscriber number, without the dialling code. */
  nationalNumber: string;
}

/** The phone fields, trimmed, in the shape the API's `phoneFields` schema expects. */
function phoneBody(phone: PhoneInput): { countryCode: string; nationalNumber: string } {
  return { countryCode: phone.countryCode.trim(), nationalNumber: phone.nationalNumber.trim() };
}

export interface PhonePasswordInput {
  phone: PhoneInput;
  password: string;
}

export interface PhoneSignUpInput extends PhonePasswordInput {
  displayName: string;
}

export interface PhoneSignUpResult {
  session: AuthSession;
  /** True while the profile is unfinished, i.e. onboarding is next. */
  onboardingRequired: boolean;
}

/**
 * Creates an account from a name, a number and a password, and stores the session.
 *
 * The API signs the member in as part of registering - the password has just been
 * checked - so there is no second step here. `phone_taken` is the one failure the
 * screen has to present as an instruction rather than an error: the number already
 * has an account, so the answer is to sign in.
 */
export async function registerWithPassword(input: PhoneSignUpInput): Promise<PhoneSignUpResult> {
  const payload = await apiRequest<Record<string, unknown>>('/api/auth/register', {
    method: 'POST',
    auth: 'none',
    body: {
      phone: phoneBody(input.phone),
      password: input.password,
      displayName: input.displayName.trim(),
    },
  });

  const session = await saveSession(payload);

  return { session, onboardingRequired: payload.onboardingRequired === true };
}

/** Signs in with a phone number and a password, and stores the session. */
export async function signInWithPassword(input: PhonePasswordInput): Promise<AuthSession> {
  const payload = await apiRequest<Record<string, unknown>>('/api/auth/login', {
    method: 'POST',
    auth: 'none',
    body: { phone: phoneBody(input.phone), password: input.password },
  });

  return saveSession(payload);
}

/**
 * Replaces the password of the signed-in account.
 *
 * The default `auth: 'bearer'` is what makes the account unforgeable here: the API
 * takes the identity from the access token, never from the body, and it checks the
 * current password itself - this form is a convenience, not the rule.
 *
 * The same call signs every *other* device out (`password_changed`), and leaves
 * this one signed in, so nothing on the client has to re-authenticate after it.
 */
export async function changeMyPassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  await apiRequest('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: input.currentPassword, newPassword: input.newPassword },
  });
}

/** What a completed deletion removed, as the API reports it. */
export interface AccountDeletionSummary {
  /** Owned groups with nobody else in them, archived on the way out. */
  archivedGroups: number;
  /** Events the account had created, cancelled before their rows followed it. */
  cancelledEvents: number;
  /** Chat messages the account had sent. */
  removedMessages: number;
}

/**
 * Closes the account. There is no partial version and no way back.
 *
 * The API re-verifies the password - a session is not treated as proof of ownership -
 * and `confirm` has to be the word `DELETE`, so this cannot be sent by accident.
 * Every session on the account goes with it, including this device's, which is why
 * the caller clears the stored session rather than retrying anything.
 */
export async function deleteMyAccount(input: { password: string; confirm: string }): Promise<AccountDeletionSummary> {
  const payload = await apiRequest<Partial<AccountDeletionSummary>>('/api/account', {
    method: 'DELETE',
    body: { password: input.password, confirm: input.confirm },
  });

  return {
    archivedGroups: payload?.archivedGroups ?? 0,
    cancelledEvents: payload?.cancelledEvents ?? 0,
    removedMessages: payload?.removedMessages ?? 0,
  };
}

export interface OtpRequestResult {
  /** Masked for display, e.g. `+********1234`. */
  phone: string;
  expiresInSeconds: number;
  /** Seconds to wait before the resend control becomes usable. */
  resendAfterSeconds: number;
  transport: 'log' | 'sms';
  /** False for the `log` transport: nothing left the server. */
  delivered: boolean;
  /** True when an SMS provider was configured and refused the message. */
  failed: boolean;
}

export interface OtpVerifyResult {
  /** True when this verification created the account. */
  isNewAccount: boolean;
  /** True when the profile is unfinished, i.e. onboarding is next. */
  onboardingRequired: boolean;
  session: AuthSession;
}

/** Asks for a one-time code - the fallback for an account that has no password. */
export async function requestPhoneOtp(input: PhoneInput): Promise<OtpRequestResult> {
  const payload = await apiRequest<Partial<OtpRequestResult>>('/api/auth/otp/request', {
    method: 'POST',
    auth: 'none',
    body: phoneBody(input),
  });

  return {
    phone: typeof payload?.phone === 'string' ? payload.phone : '',
    expiresInSeconds: typeof payload?.expiresInSeconds === 'number' ? payload.expiresInSeconds : 300,
    resendAfterSeconds: typeof payload?.resendAfterSeconds === 'number' ? payload.resendAfterSeconds : 60,
    transport: payload?.transport === 'sms' ? 'sms' : 'log',
    delivered: payload?.delivered === true,
    failed: payload?.failed === true,
  };
}

/**
 * Verifies a code and stores the session it produces.
 *
 * The fallback path, for an account created by a code and never given a password.
 * The session is stored exactly as `signInWithPassword` stores one, so
 * `AuthProvider` and the root guard cannot tell the two credentials apart.
 */
export async function verifyPhoneOtp(input: PhoneInput & { code: string }): Promise<OtpVerifyResult> {
  const payload = await apiRequest<Record<string, unknown>>('/api/auth/otp/verify', {
    method: 'POST',
    auth: 'none',
    body: { ...phoneBody(input), code: input.code.trim() },
  });

  const session = await saveSession(payload);

  return {
    isNewAccount: payload.isNewAccount === true,
    onboardingRequired: payload.onboardingRequired === true,
    session,
  };
}

/** The session persisted from a previous run, or `null`. */
export async function fetchCurrentSession(): Promise<AuthSession | null> {
  return readSession();
}

/**
 * Signs out on this device.
 *
 * The refresh-token call is best effort: a network failure must not strand the
 * member inside the app. The token is revoked server-side when the call lands,
 * and it expires on its own when it does not.
 */
export async function signOutSession(): Promise<void> {
  const session = await readSession();

  if (session) {
    try {
      await apiRequest('/api/auth/logout', {
        method: 'POST',
        auth: 'none',
        body: { refreshToken: session.refreshToken },
      });
    } catch {
      // Ignored on purpose - see above.
    }
  }

  await clearSession();
}

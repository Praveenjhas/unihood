/**
 * Authentication feature.
 *
 * `AuthProvider` wraps the app (see `app/_layout.tsx`); screens read the session
 * with `useAuth()` and call the transport functions below directly. The provider
 * is not in the middle of sign-in deliberately: the transport stores the resulting
 * session, and the subscription inside the provider is what turns that into UI
 * state, so a screen never has to hand a session back after a call.
 *
 * The surface is a phone number and a password: `registerWithPassword` and
 * `signInWithPassword`, plus the shared `signOutSession`. `fetchCurrentSession` is
 * what the provider restores on a cold start, and `MIN_PASSWORD_LENGTH` is the
 * one rule the form mirrors from the API. The `/api/auth/otp/*` calls stay in
 * `authApi` but are not re-exported: no screen offers a one-time code any more.
 */
export { AuthProvider, useAuth, type AuthStatus, type AuthValue } from './AuthProvider';
export {
  MIN_PASSWORD_LENGTH,
  changeMyPassword,
  deleteMyAccount,
  fetchCurrentSession,
  registerWithPassword,
  signInWithPassword,
  signOutSession,
  type PhoneInput,
  type PhonePasswordInput,
  type PhoneSignUpInput,
  type PhoneSignUpResult,
  type AccountDeletionSummary,
} from './authApi';



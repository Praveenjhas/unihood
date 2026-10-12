/**
 * Session provider.
 *
 * Owns the two things every screen needs to know about "who is using the app":
 *
 * 1. **the session** - restored from AsyncStorage on a cold start and kept in
 *    step through `subscribeToSession`, which is the only reliable source: a
 *    renewal, a sign-out on this device, and the client clearing a session it
 *    could no longer renew all arrive there.
 * 2. **the profile row** - loaded once per signed-in member, refreshed on demand,
 *    and replaced in place whenever this device saves an edit, so the UI never
 *    shows a stale name.
 *
 * Since Phase 5 the identity behind that session has been a **phone number**, and
 * the credential in front of it is now a **password** (the sign-in screen has the
 * create-account half too, so there is one screen rather than two): a member signs
 * in with their number and password, and the session the API returns is the same
 * shape it always was. `phone`, `email` and `isSignedIn` are the surface - no
 * screen reads the raw session - which is what let the credential change without
 * touching a single discovery, group or event screen.
 *
 * The email deep-link handling that used to live here (confirmation links, reset
 * links) is gone with the email screens. The backend still honours those tokens
 * for accounts created before this phase; nothing in the app issues them.
 *
 * The provider is deliberately the only writer of the profile row: the onboarding
 * steps and the editor both call `saveProfile`, which goes through `PUT
 * /api/profile/me` (one transaction, server-side validation) and hands back the
 * saved row.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { clearSession, isBackendConfigured, subscribeToSession, toError, type AuthSession } from '../../lib';
import type { Profile, ProfileDraft } from '../../types';
import { fetchMyProfile, saveMyProfile } from '../profile/profileRepo';
import { deleteMyAccount, fetchCurrentSession, signOutSession } from './authApi';

export type AuthStatus = 'unconfigured' | 'restoring' | 'signed-out' | 'signed-in';

export interface AuthValue {
  status: AuthStatus;
  /** The raw session. Prefer `userId` / `phone` / `email` / `isSignedIn` in screens. */
  session: AuthSession | null;
  userId: string | null;
  /** The E.164 number the member signed in with, or `null` for a legacy account. */
  phone: string | null;
  /** `null` for an account that only ever gave a phone number. */
  email: string | null;
  /** The caller's own profile row, or `null` while it loads / on failure. */
  profile: Profile | null;
  /** Drives the onboarding redirect; only ever true for a saved profile. */
  profileCompleted: boolean;
  isProfileLoading: boolean;
  /** Non-null when the profile row could not be read. Retry with `refreshProfile`. */
  profileError: Error | null;
  isConfigured: boolean;
  isSignedIn: boolean;
  refreshProfile: () => void;
  /**
   * Writes the draft through the API and updates the cached profile.
   *
   * `options.complete` is `false` for an onboarding step that is not the last
   * one: the row is saved (so a killed app does not lose it) but the profile
   * stays unfinished, and the guard sends the member back into onboarding until
   * they finish. Every other caller leaves it out, which finishes the profile.
   */
  saveProfile: (draft: ProfileDraft, options?: { complete?: boolean }) => Promise<Profile>;
  signOut: () => Promise<void>;
  /**
   * Closes the account for good, then clears the local session.
   *
   * `confirm` is the word the deletion screen makes the member type: the API refuses
   * anything else, so passing it through unchanged is what keeps the confirmation a
   * rule rather than a formality. Nothing navigates from here either - clearing the
   * session is what makes the root guard swap the app for the welcome screen, the
   * same way a sign-out does.
   */
  deleteAccount: (input: { password: string; confirm: string }) => Promise<void>;
}

/** One profile read: the member it belongs to, and which attempt it was. */
interface ProfileState {
  userId: string;
  request: number;
  profile: Profile | null;
  error: Error | null;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>(isBackendConfigured ? 'restoring' : 'unconfigured');
  const [profileState, setProfileState] = useState<ProfileState | null>(null);
  const [profileRequest, setProfileRequest] = useState(0);

  const userId = session?.user.id ?? null;
  const phone = session?.user.phone ?? null;
  const email = session?.user.email ?? null;

  // ---- 1. the stored session ------------------------------------------------
  useEffect(() => {
    if (!isBackendConfigured) return undefined;

    let active = true;

    // Every write and every clear goes through the client, so this single
    // subscription keeps the provider in step with renewals - and with a session
    // the client gave up on because the server refused to renew it.
    const unsubscribe = subscribeToSession((next) => {
      setSession(next);
      setStatus(next ? 'signed-in' : 'signed-out');
    });

    void fetchCurrentSession()
      .then((restored) => {
        if (!active) return;
        setSession(restored);
        setStatus(restored ? 'signed-in' : 'signed-out');
      })
      .catch(() => {
        // A session that cannot be restored or renewed is not something the
        // member can act on: from here it is simply "signed out".
        if (!active) return;
        setSession(null);
        setStatus('signed-out');
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // ---- 2. the profile row ---------------------------------------------------
  useEffect(() => {
    // With no session there is nothing to read, and the values below are already
    // hidden by the member comparison.
    if (!userId) return undefined;

    let active = true;

    void fetchMyProfile()
      .then((next) => {
        if (!active) return;
        setProfileState({ userId, request: profileRequest, profile: next, error: null });
      })
      .catch((caught) => {
        if (!active) return;
        // Recorded even on failure: an error is an answer, and the retry path
        // (`refreshProfile`) is a new request rather than a re-render.
        setProfileState({ userId, request: profileRequest, profile: null, error: toError(caught) });
      });

    return () => {
      active = false;
    };
  }, [userId, profileRequest]);

  // A profile read is current only for the member and the attempt it was made
  // for; anything else is stale and must not be handed to a screen.
  const profileIsCurrent = userId !== null && profileState?.userId === userId;
  const currentProfile = profileIsCurrent ? (profileState?.profile ?? null) : null;
  const currentProfileError = profileIsCurrent ? (profileState?.error ?? null) : null;
  const isProfileLoading =
    userId !== null && !(profileIsCurrent && profileState?.request === profileRequest);

  const refreshProfile = useCallback(() => setProfileRequest((value) => value + 1), []);

  const saveProfile = useCallback(
    async (draft: ProfileDraft, options: { complete?: boolean } = {}): Promise<Profile> => {
      const saved = await saveMyProfile(draft, options);
      if (userId) setProfileState({ userId, request: profileRequest, profile: saved, error: null });
      return saved;
    },
    [profileRequest, userId],
  );

  const signOut = useCallback(async () => {
    await signOutSession();
    // `subscribeToSession` clears the session; clearing the profile here keeps
    // the next sign-in from flashing the previous member's name.
    setProfileState(null);
  }, []);

  const deleteAccount = useCallback(async (input: { password: string; confirm: string }) => {
    await deleteMyAccount(input);
    // The account row - and every session on it, this device's included - is gone by
    // now, so the stored session is cleared exactly as a sign-out would clear it.
    await clearSession();
    setProfileState(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      session,
      userId,
      phone,
      email,
      profile: currentProfile,
      profileCompleted: currentProfile?.profileCompleted ?? false,
      isProfileLoading,
      profileError: currentProfileError,
      isConfigured: isBackendConfigured,
      isSignedIn: status === 'signed-in',
      refreshProfile,
      saveProfile,
      signOut,
      deleteAccount,
    }),
    [
      status,
      session,
      userId,
      phone,
      email,
      currentProfile,
      currentProfileError,
      isProfileLoading,
      refreshProfile,
      saveProfile,
      signOut,
      deleteAccount,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Reads the session. Throws when used outside `AuthProvider`, so a missing
 * provider fails loudly in development instead of rendering a signed-out app.
 */
export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an <AuthProvider>.');
  }
  return context;
}

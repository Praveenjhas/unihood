import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { AuthProvider, useAuth } from '../src/features/auth';
import { AppStoreProvider } from '../src/store/appStore';
import { colors, fontAssets } from '../src/theme';

/**
 * Keep the splash up until the fonts are ready. Called at module scope on
 * purpose: the native splash must be held before the first render happens.
 * The catch is required because the promise rejects if the splash has already
 * been hidden, which happens on every Fast Refresh.
 */
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * How long the launch screen may wait for the profile row before letting the
 * member in anyway. A network that never answers must not trap them behind a
 * splash screen; the affected screen reports the failure and offers a retry.
 */
const PROFILE_BOOT_TIMEOUT_MS = 5000;

/**
 * Every route in the app, grouped by the states a member can be in.
 *
 * `Stack.Protected` removes a screen from the navigator while its guard is
 * false, and redirects away from it if it is already on screen. That makes the
 * whole session machine a property of this one tree instead of a redirect
 * sprinkled through every screen:
 *
 *   no backend configured -> `/setup-required` (nothing else can work)
 *   signed out            -> the `(auth)` stack (welcome, sign-in)
 *   signed in, unfinished -> `/onboarding`
 *   signed in, complete   -> the app
 *
 * A screen may only ever be declared in one active group, so the guards are
 * written never to overlap: the two signed-in groups are mutually exclusive on
 * `profileCompleted`.
 *
 * Phase 5 removed the `passwordRecoveryPending` escape hatch that used to sit in
 * these guards: with no password there is no reset link to come back from, so
 * "signed in" now means exactly one thing.
 */
function RootStack() {
  const { isConfigured, isSignedIn, profileCompleted } = useAuth();

  const showSetup = !isConfigured;
  const showAuth = isConfigured && !isSignedIn;
  const showOnboarding = isConfigured && isSignedIn && !profileCompleted;
  const showApp = isConfigured && isSignedIn && profileCompleted;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.paper },
      }}
    >
      <Stack.Protected guard={showSetup}>
        <Stack.Screen name="setup-required" />
      </Stack.Protected>

      <Stack.Protected guard={showAuth}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>

      <Stack.Protected guard={showOnboarding}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>

      <Stack.Protected guard={showApp}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="person/[id]" />
        <Stack.Screen name="group/[id]" />
        <Stack.Screen name="group/manage/[id]" />
        <Stack.Screen name="group/edit/[id]" />
        <Stack.Screen name="event/[id]" />
        <Stack.Screen name="event/edit/[id]" />
        <Stack.Screen name="profile/edit" />
        <Stack.Screen name="profile/change-password" />
        <Stack.Screen name="profile/delete-account" />
        <Stack.Screen name="create/group" />
        <Stack.Screen name="create/event" />
      </Stack.Protected>
    </Stack>
  );
}

/**
 * The launch gate.
 *
 * Fonts and the restored session have to be in before a single screen can be
 * chosen, and — for a member who is already signed in — so does the profile row,
 * because `profile_completed` is what decides between onboarding and the app.
 * Waiting for it here costs one network round trip behind the launch screen and
 * buys the alternative away: a flash of "set up your profile" on every cold
 * start while the row is still loading.
 *
 * The wait is bounded, and the latch is one-way: hiding the splash cannot be
 * undone, so a later render must never be able to blank the app.
 */
function AppShell({ fontsReady }: { fontsReady: boolean }) {
  const { status, isSignedIn, profile, profileError } = useAuth();
  const [isLaunched, setIsLaunched] = useState(false);

  const profileSettled = !isSignedIn || profile !== null || profileError !== null;
  const canLaunch = fontsReady && status !== 'restoring' && profileSettled;

  // Adjusting state during render — React's documented pattern for a value that
  // is derived from props/state — rather than in an effect: an effect would let
  // one frame of the app render behind the splash and then re-render.
  if (!isLaunched && canLaunch) setIsLaunched(true);

  useEffect(() => {
    // The session is in but the profile request is still out.
    if (isLaunched || !isSignedIn || profileSettled) return;
    const timer = setTimeout(() => setIsLaunched(true), PROFILE_BOOT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isLaunched, isSignedIn, profileSettled]);

  useEffect(() => {
    if (!isLaunched) return;
    void SplashScreen.hideAsync().catch(() => undefined);
  }, [isLaunched]);

  // Render nothing while the splash is still visible — this avoids a frame of
  // unstyled text under the launch screen.
  if (!isLaunched) return null;

  return <RootStack />;
}

/**
 * Root layout.
 *
 * Responsibilities, in order:
 * 1. Own the session (`AuthProvider`) so every screen below can read it.
 * 2. Layer the local relationship store on top (Groups/Events toggles).
 * 3. Load the editorial font pair so headings never flash in a fallback face.
 * 4. Choose the routes for the current session state and hold the splash until
 *    that choice is safe to make (see `AppShell`).
 *
 * Font failure is not fatal: if a family fails to load we continue with the
 * platform default rather than trapping the user on the splash screen. Type
 * hierarchy still reads correctly because it comes from size and weight.
 */
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  const fontsReady = fontsLoaded || Boolean(fontError);

  return (
    <AuthProvider>
      <AppStoreProvider>
        <StatusBar style="dark" />
        <AppShell fontsReady={fontsReady} />
      </AppStoreProvider>
    </AuthProvider>
  );
}

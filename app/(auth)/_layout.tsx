import { Stack } from 'expo-router';

import { colors } from '../../src/theme';

/**
 * The sign-in flow.
 *
 * It gets its own stack so its screens can push and pop against each other
 * (welcome → sign-in) without touching the app's main navigator, and so the root
 * layout can guard the whole flow with a single `Stack.Protected`.
 *
 * Two screens, where there used to be six: `welcome` offers the only two things a
 * signed-out visitor can do - create an account or sign in - and both of them land
 * on `sign-in`, which is one phone-and-password form. `welcome` is first because
 * it is where the router lands when it has to pick a screen itself (a sign-out, or
 * a guard that has just closed the app section).
 */
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.paper },
      }}
    >
      <Stack.Screen name="welcome" />
      <Stack.Screen name="sign-in" />
    </Stack>
  );
}

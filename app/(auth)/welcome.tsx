import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, Card, Screen, ScreenHeader } from '../../src/components';
import { routes } from '../../src/lib';
import { spacing } from '../../src/theme';

/** One reason-to-be-here card on the welcome screen. */
function Point({ title, body }: { title: string; body: string }) {
  return (
    <Card style={styles.point} muted>
      <AppText variant="bodyStrong">{title}</AppText>
      <AppText variant="meta">{body}</AppText>
    </Card>
  );
}

/**
 * Welcome — the landing screen for a member who is not signed in.
 *
 * Two doors, and only two: create an account, or sign in. They are separate
 * buttons because that choice is the one thing a visitor already knows about
 * themselves, and signing in is the wrong default for a screen nobody reaches
 * with a session. Both open the same screen — `/sign-in`, with `?mode=create` on
 * the creating one.
 *
 * The pitch is kept to three promises that are actually true of this phase
 * (nearby discovery is opt-in, ranking is by shared interests, groups and events
 * already work), because nothing is more expensive later than a first screen that
 * oversold the app.
 */
export default function WelcomeScreen() {
  const router = useRouter();

  return (
    <Screen
      contentStyle={styles.content}
      footer={
        <View style={styles.footer}>
          <Button
            label="Create my account"
            icon="person-add-outline"
            variant="primary"
            fullWidth
            onPress={() => router.push(routes.createAccount())}
          />
          <Button
            label="Sign in"
            icon="log-in-outline"
            variant="secondary"
            fullWidth
            onPress={() => router.push(routes.signIn)}
          />
        </View>
      }
    >
      <ScreenHeader
        eyebrow="Welcome"
        title="Find your people."
        subtitle="Unihood shows you who is around, what they are into, and which groups and events are worth your evening."
      />

      <View style={styles.points}>
        <Point
          title="People nearby"
          body="Opt in once and you appear to members who are close by — never to the whole app."
        />
        <Point
          title="Shared interests"
          body="Results are ranked by what you have in common, so a conversation has somewhere to start."
        />
        <Point
          title="Groups and events"
          body="Societies, study sessions and nights out, with the details already in front of you."
        />
      </View>

      <AppText variant="meta">
        Three fields and you are in: your name, your number and a password. The password is hashed before it is stored
        and the number is never shown to another member - you choose what is shared, and every part of it can be
        turned off again from your profile.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xxl,
  },
  footer: {
    gap: spacing.sm,
  },
  points: {
    gap: spacing.md,
  },
  point: {
    gap: spacing.xxs,
  },
});

import { StyleSheet, View } from 'react-native';

import { AppText, Card, ListDivider, ListRow, Screen, ScreenHeader, Tag } from '../src/components';
import { env } from '../src/lib';
import { spacing } from '../src/theme';

/** One numbered instruction. */
function Step({ index, children }: { index: number; children: string }) {
  return (
    <View style={styles.step}>
      <AppText variant="label">{String(index)}</AppText>
      <AppText variant="bodySecondary" style={styles.stepText}>
        {children}
      </AppText>
    </View>
  );
}

/**
 * The configuration screen.
 *
 * Every account, profile, location and discovery query comes from the Unihood API,
 * so with no URL the app can show nothing — and this screen is
 * the only route the root layout exposes in that state. It is written for the
 * person who will fix it (whoever is running the project), not for a member, and
 * it deliberately offers no way to "continue anyway": a fake signed-in state is
 * worse than an honest stop.
 */
export default function SetupRequiredScreen() {
  const hasApiUrl = env.apiBaseUrl.length > 0;

  return (
    <Screen contentStyle={styles.content}>
      <ScreenHeader
        eyebrow="Configuration"
        title="Unihood needs its API address"
        subtitle="Accounts, profiles, locations and nearby discovery all come from the Unihood API. Set the URL below and restart the dev server."
      />

      <Card style={styles.card}>
        <ListRow
          title="EXPO_PUBLIC_API_BASE_URL"
          meta={hasApiUrl ? 'Set' : 'Missing'}
          trailing={<Tag label={hasApiUrl ? 'Set' : 'Missing'} variant={hasApiUrl ? 'soft' : 'neutral'} />}
        />
        <ListDivider />
        <ListRow title="EXPO_PUBLIC_APP_ENV" meta={env.appEnv} />
      </Card>

      <View style={styles.steps}>
        <Step index={1}>Copy `.env.example` to `.env` in the project root.</Step>
        <Step index={2}>
          Point `EXPO_PUBLIC_API_BASE_URL` at the running backend: `http://localhost:4000` on a simulator, or the LAN
          address of the machine running the backend (for example `http://192.168.0.5:4000`) for a physical phone.
        </Step>
        <Step index={3}>
          Start the backend: `cd backend`, then `npm install`, `npm run db:migrate` and `npm run dev`. Its `/health`
          route should answer before the app can.
        </Step>
        <Step index={4}>
          Restart the dev server. `EXPO_PUBLIC_*` values are inlined at bundle time, so a running Metro keeps the old
          ones.
        </Step>
      </View>

      <AppText variant="meta">
        The API is the only thing holding a database connection, so there is no key in this app: the access token from
        signing in is the whole credential, and it never leaves the device except as a request header.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xxl,
  },
  card: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  steps: {
    gap: spacing.lg,
  },
  step: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  stepText: {
    flex: 1,
  },
});

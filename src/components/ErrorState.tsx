import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View } from 'react-native';

import { colors, radii, spacing } from '../theme';
import { AppText } from './AppText';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry: () => void;
  /** Rendered small and muted under the retry button, for debugging context. */
  detail?: string;
}

/**
 * Failure panel. `useMockQuery` never fails on its own, but the retry path is
 * live now so Phase 2 can surface real network errors with no UI work.
 */
export function ErrorState({ title = 'Something went wrong', message, onRetry, detail }: ErrorStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.iconWell}>
        <Ionicons name="alert-circle-outline" size={22} color={colors.danger} />
      </View>
      <AppText variant="heading" align="center">
        {title}
      </AppText>
      <AppText variant="bodySecondary" align="center" style={styles.message}>
        {message}
      </AppText>
      <Button label="Try again" icon="refresh" variant="secondary" onPress={onRetry} style={styles.action} />
      {detail ? (
        <AppText variant="label" align="center" style={styles.detail}>
          {detail}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  iconWell: {
    width: 48,
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: colors.dangerSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  message: {
    maxWidth: 320,
  },
  action: {
    marginTop: spacing.md,
  },
  detail: {
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
});

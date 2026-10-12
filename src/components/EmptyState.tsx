import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View } from 'react-native';

import { colors, radii, spacing } from '../theme';
import { AppText } from './AppText';
import { Button, type IoniconName } from './Button';

export interface EmptyStateProps {
  title: string;
  message: string;
  icon?: IoniconName;
  /** Optional way out of the empty state (clear filters, create something). */
  action?: { label: string; onPress: () => void };
}

/**
 * Shown when a query succeeds but returns nothing. Empty is a normal state for
 * a filterable list, so it gets a real explanation and an escape hatch rather
 * than blank space.
 */
export function EmptyState({ title, message, icon = 'compass-outline', action }: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.iconWell}>
        <Ionicons name={icon} size={22} color={colors.textSecondary} />
      </View>
      <AppText variant="heading" align="center">
        {title}
      </AppText>
      <AppText variant="bodySecondary" align="center" style={styles.message}>
        {message}
      </AppText>
      {action ? <Button label={action.label} variant="secondary" onPress={action.onPress} style={styles.action} /> : null}
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
    backgroundColor: colors.surfaceMuted,
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
});

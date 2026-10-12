import { Pressable, StyleSheet, View } from 'react-native';

import { colors, spacing } from '../theme';
import { AppText } from './AppText';

export interface SectionHeadingProps {
  title: string;
  /** Optional right-aligned text action, e.g. "See all". */
  action?: { label: string; onPress: () => void };
  /** Count shown after the title as quiet metadata. */
  count?: number;
}

/**
 * Heading that opens a group of results inside a screen. The page heading is
 * `display`; this is one step down so the hierarchy stays obvious at a glance.
 */
export function SectionHeading({ title, action, count }: SectionHeadingProps) {
  return (
    <View style={styles.row}>
      <View style={styles.titleGroup}>
        <AppText variant="title">{title}</AppText>
        {typeof count === 'number' ? (
          <AppText variant="label" color={colors.textSecondary}>
            {count}
          </AppText>
        ) : null}
      </View>

      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          hitSlop={8}
          style={({ pressed }) => (pressed ? styles.pressed : undefined)}
        >
          <AppText variant="label" color={colors.olive}>
            {action.label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  titleGroup: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    flexShrink: 1,
  },
  pressed: {
    opacity: 0.6,
  },
});

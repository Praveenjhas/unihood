import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, spacing } from '../theme';
import { AppText } from './AppText';

export interface ListRowProps {
  title: string;
  meta?: string;
  onPress?: () => void;
  /** Avatar, icon well or date block. */
  leading?: ReactNode;
  /** Replaces the default chevron — e.g. a toggle or a value. */
  trailing?: ReactNode;
  accessibilityLabel?: string;
}

/**
 * Compact row used inside cards and detail lists (member lists, "your groups",
 * profile sections). Renders as a plain `View` when no `onPress` is given, so a
 * non-interactive row never pretends to be tappable.
 */
export function ListRow({ title, meta, onPress, leading, trailing, accessibilityLabel }: ListRowProps) {
  const content = (
    <>
      {leading}
      <View style={styles.text}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {title}
        </AppText>
        {meta ? (
          <AppText variant="meta" numberOfLines={1}>
            {meta}
          </AppText>
        ) : null}
      </View>
      {trailing ?? (onPress ? <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} /> : null)}
    </>
  );

  if (!onPress) {
    return <View style={styles.row}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      {content}
    </Pressable>
  );
}

/** Hairline divider that matches the border token used by cards. */
export function ListDivider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  text: {
    flex: 1,
    gap: spacing.xxs,
  },
  pressed: {
    opacity: 0.6,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
});

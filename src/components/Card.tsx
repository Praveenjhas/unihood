import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, shadows, spacing } from '../theme';

export interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Slightly recessed surface, for nested or secondary content. */
  muted?: boolean;
}

/**
 * Content surface. Campus Editorial leans on a hairline border rather than a
 * drop shadow, so cards read as printed panels instead of floating tiles.
 */
export function Card({ children, style, muted = false }: CardProps) {
  return <View style={[styles.card, muted ? styles.muted : null, style]}>{children}</View>;
}

export interface PressableCardProps extends CardProps {
  onPress: () => void;
  /** Required: cards carry their own heading, which is not a usable a11y name. */
  accessibilityLabel: string;
  accessibilityHint?: string;
}

/** A `Card` that behaves like a single button. */
export function PressableCard({
  children,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
  muted = false,
}: PressableCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [styles.card, muted ? styles.muted : null, pressed ? styles.pressed : null, style]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadows.hairline,
  },
  muted: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
  },
  pressed: {
    opacity: 0.88,
  },
});

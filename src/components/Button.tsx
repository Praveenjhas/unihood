import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, layout, radii, spacing } from '../theme';
import { AppText } from './AppText';

/** Any valid Ionicons glyph — keeps icon names checked by the compiler. */
export type IoniconName = ComponentProps<typeof Ionicons>['name'];

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IoniconName;
  disabled?: boolean;
  /** Shows a spinner and blocks presses while a future async action runs. */
  loading?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

/**
 * The single button in the app. Four variants, two sizes — enough for every
 * action in Phase 1 and few enough that the UI stays consistent.
 *
 * `secondary` is the default choice for anything reversible (Join/RSVP); reach
 * for `primary` only for the one action a screen is really about.
 */
export function Button({
  label,
  onPress,
  variant = 'secondary',
  size = 'md',
  icon,
  disabled = false,
  loading = false,
  fullWidth = false,
  style,
  accessibilityHint,
}: ButtonProps) {
  const isInactive = disabled || loading;
  const { backgroundColor, borderColor, textColor } = VARIANT_COLORS[variant];
  const height = size === 'sm' ? layout.controlHeightSm : layout.controlHeight;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isInactive, busy: loading }}
      accessibilityHint={accessibilityHint}
      disabled={isInactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { height, backgroundColor, borderColor },
        size === 'sm' ? styles.paddingSm : styles.paddingMd,
        fullWidth ? styles.fullWidth : null,
        pressed && !isInactive ? styles.pressed : null,
        isInactive ? styles.inactive : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <View style={styles.content}>
          {icon ? <Ionicons name={icon} size={size === 'sm' ? 15 : 17} color={textColor} /> : null}
          <AppText variant={size === 'sm' ? 'buttonSmall' : 'button'} color={textColor}>
            {label}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

const VARIANT_COLORS: Record<ButtonVariant, { backgroundColor: string; borderColor: string; textColor: string }> = {
  primary: { backgroundColor: colors.ink, borderColor: colors.ink, textColor: colors.onInk },
  secondary: { backgroundColor: colors.surface, borderColor: colors.borderStrong, textColor: colors.ink },
  ghost: { backgroundColor: colors.transparent, borderColor: colors.transparent, textColor: colors.olive },
  danger: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerSoft, textColor: colors.danger },
};

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
  },
  paddingMd: {
    paddingHorizontal: spacing.xl,
  },
  paddingSm: {
    paddingHorizontal: spacing.lg,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  pressed: {
    opacity: 0.82,
  },
  inactive: {
    opacity: 0.5,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});

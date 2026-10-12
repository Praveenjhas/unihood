import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '../theme';
import { AppText } from './AppText';
import type { IoniconName } from './Button';

export type TagVariant = 'soft' | 'neutral' | 'outline';

const VARIANT_STYLES: Record<TagVariant, { backgroundColor: string; borderColor: string; textColor: string }> = {
  soft: { backgroundColor: colors.oliveSoft, borderColor: colors.oliveBorder, textColor: colors.oliveDeep },
  neutral: { backgroundColor: colors.surfaceMuted, borderColor: colors.border, textColor: colors.textSecondary },
  outline: { backgroundColor: colors.transparent, borderColor: colors.borderStrong, textColor: colors.ink },
};

export interface TagProps {
  label: string;
  variant?: TagVariant;
  icon?: IoniconName;
  style?: StyleProp<ViewStyle>;
}

/** Non-interactive label chip: categories, visibility, "Free", interests. */
export function Tag({ label, variant = 'neutral', icon, style }: TagProps) {
  const palette = VARIANT_STYLES[variant];

  return (
    <View
      style={[
        styles.base,
        { backgroundColor: palette.backgroundColor, borderColor: palette.borderColor },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={12} color={palette.textColor} /> : null}
      <AppText variant="tag" color={palette.textColor}>
        {label}
      </AppText>
    </View>
  );
}

export interface TagRowProps {
  labels: readonly string[];
  variant?: TagVariant;
  /** Caps the row so a long interest list cannot push a card's actions off screen. */
  limit?: number;
  style?: StyleProp<ViewStyle>;
}

/** Wraps a list of labels into chips, with a `+n` overflow chip when capped. */
export function TagRow({ labels, variant = 'neutral', limit, style }: TagRowProps) {
  const visible = limit ? labels.slice(0, limit) : labels;
  const hiddenCount = labels.length - visible.length;

  if (labels.length === 0) return null;

  return (
    <View style={[styles.row, style]}>
      {visible.map((label) => (
        <Tag key={label} label={label} variant={variant} />
      ))}
      {hiddenCount > 0 ? <Tag label={`+${hiddenCount}`} variant={variant} /> : null}
    </View>
  );
}

export interface FilterChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Spoken label, e.g. "Interest: Coding". Falls back to `label`. */
  accessibilityLabel?: string;
}

/**
 * Interactive counterpart to `Tag`, used by the filter rows. Selection is the
 * only state that earns colour in this design system.
 */
export function FilterChip({ label, selected, onPress, accessibilityLabel }: FilterChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected ? styles.chipSelected : null, pressed ? styles.chipPressed : null]}
    >
      <AppText variant="tag" color={selected ? colors.oliveDeep : colors.textSecondary}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 1,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: {
    backgroundColor: colors.oliveSoft,
    borderColor: colors.oliveBorder,
  },
  chipPressed: {
    opacity: 0.75,
  },
});

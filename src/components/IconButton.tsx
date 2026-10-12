import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet } from 'react-native';

import { colors, layout, radii } from '../theme';
import type { IoniconName } from './Button';

export interface IconButtonProps {
  name: IoniconName;
  onPress: () => void;
  /** Required: an icon alone is not an accessible name. */
  accessibilityLabel: string;
  size?: 'sm' | 'md';
  tone?: 'ink' | 'muted';
  filled?: boolean;
}

const DIMENSIONS = { sm: 32, md: layout.minTapTarget } as const;
const GLYPH_SIZES = { sm: 16, md: 20 } as const;

/**
 * Square icon-only control (back arrow, search clear, save). Always 44dp unless
 * explicitly compact, so it stays a comfortable tap target.
 */
export function IconButton({ name, onPress, accessibilityLabel, size = 'md', tone = 'ink', filled = false }: IconButtonProps) {
  const dimension = DIMENSIONS[size];
  const color = tone === 'muted' ? colors.textSecondary : colors.ink;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.base,
        {
          width: dimension,
          height: dimension,
          borderRadius: filled ? radii.pill : dimension / 2,
          backgroundColor: filled ? colors.surface : colors.transparent,
        },
        filled ? styles.bordered : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Ionicons name={name} size={GLYPH_SIZES[size]} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  bordered: {
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: {
    opacity: 0.6,
  },
});
